// POST /api/send-trucking — archive a Truck Tickets batch (report PDF AND
// the original ticket photos) under the signed-in user for the admin
// console, and email it from their own mailbox via Microsoft Graph.
//
// Body: { subject, text, recipients[], fileName, pdf (data URI or base64), date,
//         tickets: [{ id, pitTicketNo, truckNum, commodity, commodityType, tons,
//                     yards, truckingCo, jobNum, date, photo (data URI | '') }] }
// Reply: { ok:true, sent:true|false, reason?, archived:bool,
//          photosArchived:n, photosAttached:n }
//   sent:false means the caller should fall back to the device share sheet;
//   the PDF + photos are archived either way (when blob storage is up).
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');
const { getEwtContainer, safeName } = require('../shared/blob');
const { sendGraphMail } = require('../shared/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SENDS = 200;
const MAX_TICKETS = 80;
// Graph's simple sendMail caps the message around 3MB; keep attachments
// (base64 chars, ~4/3 of bytes) under this and archive the rest.
const MAIL_B64_BUDGET = 3.6 * 1024 * 1024;

function splitDataUri(v) {
  let s = String(v || '');
  let type = '';
  if (s.startsWith('data:')) {
    const comma = s.indexOf(',');
    const head = s.slice(5, comma);
    type = head.split(';')[0] || '';
    s = s.slice(comma + 1);
  }
  return { b64: s, type };
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('send-trucking ensureUser', e);
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
  const subject = String(body.subject || 'EBCC Trucking Tickets').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'Trucking_Tickets.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'Trucking_Tickets.pdf';
  const pdfB64 = splitDataUri(body.pdf).b64;
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 8 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 80);
  const date = str(body.date, 20) || 'nodate';
  const tickets = (Array.isArray(body.tickets) ? body.tickets : []).slice(0, MAX_TICKETS).filter((t) => t && typeof t === 'object');
  const stamp = Date.now();

  // ---- Archive the report + every ticket photo (same private container as EWT PDFs) ----
  let pdfBlobPath = '';
  const photoBlobs = [];
  let container = null;
  try {
    container = await getEwtContainer();
    const name = 'trucking-' + safeName(date) + '-' + stamp + '.pdf';
    pdfBlobPath = me.id + '/' + name;
    await container.getBlockBlobClient(pdfBlobPath).uploadData(Buffer.from(pdfB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
  } catch (e) {
    context.log.warn('send-trucking pdf upload failed: ' + (e.message || e));
    pdfBlobPath = '';
    container = null;
  }
  const photos = []; // { name, b64, type, ticketId, pitTicketNo }
  tickets.forEach((t, i) => {
    const p = splitDataUri(t.photo);
    if (!p.b64 || p.b64.length < 100 || p.b64.length > 6 * 1024 * 1024) return;
    const type = p.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const ext = type === 'image/png' ? 'png' : 'jpg';
    photos.push({
      name: 'trucking-' + safeName(date) + '-' + stamp + '-' + (i + 1) + '.' + ext,
      b64: p.b64, type,
      ticketId: str(t.id, 40), pitTicketNo: str(t.pitTicketNo, 40),
    });
  });
  if (container) {
    for (const ph of photos) {
      try {
        const path = me.id + '/' + ph.name;
        await container.getBlockBlobClient(path).uploadData(Buffer.from(ph.b64, 'base64'), {
          blobHTTPHeaders: { blobContentType: ph.type },
        });
        photoBlobs.push({ ticketId: ph.ticketId, pitTicketNo: ph.pitTicketNo, path });
      } catch (e) {
        context.log.warn('send-trucking photo upload failed: ' + (e.message || e));
      }
    }
  }

  // ---- Email it (only when recipients were picked): PDF + as many photos as fit ----
  let mail = { ok: false, reason: 'no-recipients' };
  let photosAttached = 0;
  if (recipients.length) {
    const attachments = [];
    let used = pdfB64.length;
    for (const ph of photos) {
      if (used + ph.b64.length > MAIL_B64_BUDGET) break;
      attachments.push({ name: 'Ticket-' + (ph.pitTicketNo || (attachments.length + 1)).replace(/[^a-zA-Z0-9._-]/g, '') + '.' + (ph.type === 'image/png' ? 'png' : 'jpg'), contentType: ph.type, b64: ph.b64 });
      used += ph.b64.length;
    }
    photosAttached = attachments.length;
    mail = await sendGraphMail(context, { fromEmail: me.email, subject, text, recipients, fileName, pdfB64, attachments });
  }

  // ---- Record the batch for the admin console (never blocks the reply) ----
  try {
    const now = new Date().toISOString();
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
    const rows = tickets.map((t) => ({
      id: str(t.id, 40), pitTicketNo: str(t.pitTicketNo, 40), truckNum: str(t.truckNum, 40),
      commodity: str(t.commodity, 60), commodityType: str(t.commodityType, 20),
      tons: str(t.tons, 12), yards: str(t.yards, 12), truckingCo: str(t.truckingCo, 80),
      jobNum: str(t.jobNum, 40), date: str(t.date, 20), hasPhoto: !!splitDataUri(t.photo).b64,
    }));
    const rec = {
      ts: now, date, subject,
      ticketCount: rows.length,
      tons: Math.round(rows.reduce((s, r) => s + num(r.tons), 0) * 10) / 10,
      tickets: rows,
      emailedTo: recipients,
      sent: !!mail.sent,
      pdfBlob: pdfBlobPath,
      photoBlobs,
      photosAttached,
    };
    const { records, users } = await getContainers();
    const docId = me.id + ':trucking_sends';
    let doc = null;
    try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
    let arr = (doc && Array.isArray(doc.data)) ? doc.data : [];
    arr.push(rec);
    if (arr.length > MAX_SENDS) arr = arr.slice(arr.length - MAX_SENDS);
    await records.items.upsert({ id: docId, ownerId: me.id, ownerEmail: me.email, type: 'trucking_sends', data: arr, updatedAt: now });
    me.counts = me.counts || {};
    me.counts.trucking_sends = arr.length;
    me.lastActiveAt = now;
    await users.items.upsert(me);
  } catch (e) {
    context.log.error('send-trucking record', e);
  }

  const base = { ok: true, archived: !!pdfBlobPath, photosArchived: photoBlobs.length, photosAttached };
  if (mail.sent) return json(context, 200, Object.assign(base, { sent: true, recipients }));
  return json(context, 200, Object.assign(base, { sent: false, reason: mail.reason, detail: mail.detail }));
};
