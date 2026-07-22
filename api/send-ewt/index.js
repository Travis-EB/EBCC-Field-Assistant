// POST /api/send-ewt — email a finalized Extra Work Ticket (PDF attached) via
// Microsoft Graph, sent from the signed-in user's own EBCC mailbox, and record
// the ticket under that user so the admin console always reflects it.
//
// Requires the app registration to have the Microsoft Graph APPLICATION
// permission "Mail.Send" with admin consent. Until that's granted, Graph
// returns 403 and this responds { ok:false, reason:'mail-permission' } —
// the app falls back to the device share sheet.
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');

const TENANT_ID = process.env.AAD_TENANT_ID || 'f95ee318-b7d4-49aa-b795-b188b614caca';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EWT_PDF_KEEP = 5; // newest N tickets keep their full PDF (stays well under Cosmos' 2MB doc cap)
const EWT_MAX = 100;

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('send-ewt ensureUser', e);
    return json(context, 500, { ok: false, error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { ok: false, error: 'Account disabled.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return json(context, 400, { ok: false, error: 'Bad request.' });

  const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
    .map((r) => String(r).trim().toLowerCase())
    .filter((r) => EMAIL_RE.test(r))
    .slice(0, 15);
  const subject = String(body.subject || 'EWT').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'EWT.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'EWT.pdf';
  let pdfB64 = String(body.pdf || '');
  if (pdfB64.startsWith('data:')) pdfB64 = pdfB64.slice(pdfB64.indexOf(',') + 1);
  if (!recipients.length) return json(context, 400, { ok: false, error: 'No valid recipients.' });
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });

  // ---- Record the ticket under this user FIRST (admin visibility never depends on mail) ----
  try {
    const t = body.ticket && typeof body.ticket === 'object' ? body.ticket : {};
    const rec = {
      ts: new Date().toISOString(),
      ticketNo: String(t.ticketNo || ''), date: String(t.date || ''),
      customer: String(t.customer || ''), jobAddress: String(t.jobAddress || ''),
      city: String(t.city || ''), state: String(t.state || ''),
      po: String(t.po || ''), jobNum: String(t.jobNum || ''), phase: String(t.phase || ''),
      description: String(t.description || ''), printName: String(t.printName || ''), title: String(t.title || ''),
      labor: Array.isArray(t.labor) ? t.labor : [],
      equipment: Array.isArray(t.equipment) ? t.equipment : [],
      materials: Array.isArray(t.materials) ? t.materials : [],
      signed: !!t.signed,
      emailedTo: recipients,
      pdf: 'data:application/pdf;base64,' + pdfB64,
    };
    const { records, users } = await getContainers();
    const docId = me.id + ':ewt_records';
    let doc = null;
    try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
    let arr = (doc && Array.isArray(doc.data)) ? doc.data : [];
    const idx = arr.findIndex((x) => x && x.ticketNo === rec.ticketNo && x.date === rec.date);
    if (idx >= 0) arr[idx] = rec; else arr.push(rec);
    if (arr.length > EWT_MAX) arr = arr.slice(arr.length - EWT_MAX);
    for (let i = 0; i < arr.length - EWT_PDF_KEEP; i++) { if (arr[i] && arr[i].pdf) arr[i].pdf = ''; }
    await records.items.upsert({
      id: docId, ownerId: me.id, ownerEmail: me.email, type: 'ewt_records',
      data: arr, updatedAt: new Date().toISOString(),
    });
    me.counts = me.counts || {};
    me.counts.ewt_records = arr.length;
    me.lastActiveAt = new Date().toISOString();
    await users.items.upsert(me);
  } catch (e) {
    context.log.error('send-ewt record', e);
    // continue — mail can still go out; client-side sync is the backstop
  }

  // ---- Send via Microsoft Graph (client credentials) ----
  const clientId = process.env.AAD_CLIENT_ID;
  const clientSecret = process.env.AAD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json(context, 200, { ok: false, reason: 'mail-not-configured' });

  let token;
  try {
    const tr = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
    });
    const td = await tr.json();
    token = td.access_token;
    if (!token) throw new Error(td.error_description || 'no token');
  } catch (e) {
    context.log.error('send-ewt token', e);
    return json(context, 200, { ok: false, reason: 'mail-permission' });
  }

  try {
    const gr = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(me.email) + '/sendMail', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: subject,
          body: { contentType: 'Text', content: text },
          toRecipients: recipients.map((r) => ({ emailAddress: { address: r } })),
          attachments: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: fileName,
            contentType: 'application/pdf',
            contentBytes: pdfB64,
          }],
        },
        saveToSentItems: true,
      }),
    });
    if (gr.status === 202) return json(context, 200, { ok: true, sent: true, recipients: recipients });
    const detail = (await gr.text().catch(() => '')).slice(0, 400);
    context.log.error('send-ewt graph ' + gr.status + ' ' + detail);
    if (gr.status === 403 || gr.status === 401) return json(context, 200, { ok: false, reason: 'mail-permission' });
    return json(context, 200, { ok: false, reason: 'mail-failed', detail: detail });
  } catch (e) {
    context.log.error('send-ewt send', e);
    return json(context, 200, { ok: false, reason: 'mail-failed' });
  }
};
