// POST /api/send-load-count — archive a Load Count day (PDF + summary) under the
// signed-in user for the admin console, and email the PDF from their own
// mailbox via Microsoft Graph to the recipients they picked.
//
// Body: { subject, text, recipients[], fileName, pdf (data URI or base64),
//         summary: { date, source, deliveredTo, contractor, checker, jobNum,
//                    trucks, loads, cy, byType[] } }
// Reply: { ok:true, sent:true|false, reason?, archived:bool }
//   sent:false means the caller should fall back to the device share sheet;
//   the PDF and summary are archived either way (when blob storage is up).
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');
const { getEwtContainer, safeName } = require('../shared/blob');
const { sendGraphMail } = require('../shared/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_DAYS = 200;

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('send-load-count ensureUser', e);
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
  const subject = String(body.subject || 'EBCC Load Count').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'Load_Count.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'Load_Count.pdf';
  let pdfB64 = String(body.pdf || '');
  if (pdfB64.startsWith('data:')) pdfB64 = pdfB64.slice(pdfB64.indexOf(',') + 1);
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });
  const s = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);
  const num = (v) => { const n = +v; return isFinite(n) ? n : 0; };

  // ---- Archive the PDF (same private container as EWT PDFs, pathed by owner) ----
  let pdfBlobPath = '';
  try {
    const container = await getEwtContainer();
    const name = 'loadcount-' + safeName(str(s.date, 20) || 'nodate') + '-' + Date.now() + '.pdf';
    pdfBlobPath = me.id + '/' + name;
    await container.getBlockBlobClient(pdfBlobPath).uploadData(Buffer.from(pdfB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
  } catch (e) {
    context.log.warn('send-load-count blob upload failed: ' + (e.message || e));
    pdfBlobPath = '';
  }

  // ---- Email it (only when recipients were picked) ----
  let mail = { ok: false, reason: 'no-recipients' };
  if (recipients.length) {
    mail = await sendGraphMail(context, { fromEmail: me.email, subject, text, recipients, fileName, pdfB64 });
  }

  // ---- Record the day for the admin console (never blocks the reply) ----
  try {
    const now = new Date().toISOString();
    const rec = {
      ts: now,
      date: str(s.date, 20), source: str(s.source), deliveredTo: str(s.deliveredTo),
      contractor: str(s.contractor), checker: str(s.checker), jobNum: str(s.jobNum, 40),
      trucks: num(s.trucks), loads: num(s.loads), cy: num(s.cy),
      byType: (Array.isArray(s.byType) ? s.byType : []).slice(0, 20).map((t) => ({
        label: str(t && t.label, 60), trucks: num(t && t.trucks), loads: num(t && t.loads), cy: num(t && t.cy),
      })),
      emailedTo: recipients,
      sent: !!mail.sent,
      pdfBlob: pdfBlobPath,
    };
    const { records, users } = await getContainers();
    const docId = me.id + ':load_count_sends';
    let doc = null;
    try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
    let arr = (doc && Array.isArray(doc.data)) ? doc.data : [];
    arr.push(rec);
    if (arr.length > MAX_DAYS) arr = arr.slice(arr.length - MAX_DAYS);
    await records.items.upsert({ id: docId, ownerId: me.id, ownerEmail: me.email, type: 'load_count_sends', data: arr, updatedAt: now });
    me.counts = me.counts || {};
    me.counts.load_count_sends = arr.length;
    me.lastActiveAt = now;
    await users.items.upsert(me);
  } catch (e) {
    context.log.error('send-load-count record', e);
  }

  if (mail.sent) return json(context, 200, { ok: true, sent: true, recipients: recipients, archived: !!pdfBlobPath });
  return json(context, 200, { ok: true, sent: false, reason: mail.reason, detail: mail.detail, archived: !!pdfBlobPath });
};
