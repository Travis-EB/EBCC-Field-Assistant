// POST /api/send-jha — archive a JHA day (PDF with signatures) under the
// signed-in user and email it from their own mailbox via Microsoft Graph,
// same mechanism as Extra Work Tickets and Load Count.
//
// Body: { subject, text, recipients[], fileName, pdf (data URI or base64),
//         summary: { jhaId, date, projectCode, projectName, preparedBy,
//                    contractor, signedCount, rosterCount, injuredNames[] } }
// Reply: { ok:true, sent:true|false, reason?, archived:bool, pdfBlob }
//   sent:false means the caller should fall back to the device share sheet;
//   the PDF is archived either way (when blob storage is up).
//
// The matching JHA in the user's jha_records doc is stamped with the send
// (emailedTo/sentTs/pdfBlob) so every device — and the admin console — sees
// it after the next sync. The client stamps its local copy too; the merge
// keeps whichever is newest.
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');
const { getEwtContainer, safeName } = require('../shared/blob');
const { sendGraphMail } = require('../shared/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('send-jha ensureUser', e);
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
  const subject = String(body.subject || 'EBCC JHA').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'JHA.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'JHA.pdf';
  let pdfB64 = String(body.pdf || '');
  if (pdfB64.startsWith('data:')) pdfB64 = pdfB64.slice(pdfB64.indexOf(',') + 1);
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });
  const s = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);

  // ---- Archive the PDF (same private container as EWT PDFs, pathed by owner) ----
  let pdfBlobPath = '';
  try {
    const container = await getEwtContainer();
    const name = 'jha-' + safeName(str(s.projectCode, 30) || 'noproj') + '-' + safeName(str(s.date, 20) || 'nodate') + '-' + Date.now() + '.pdf';
    pdfBlobPath = me.id + '/' + name;
    await container.getBlockBlobClient(pdfBlobPath).uploadData(Buffer.from(pdfB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
  } catch (e) {
    context.log.warn('send-jha blob upload failed: ' + (e.message || e));
    pdfBlobPath = '';
  }

  // ---- Email it (only when recipients were picked) ----
  let mail = { ok: false, reason: 'no-recipients' };
  if (recipients.length) {
    mail = await sendGraphMail(context, { fromEmail: me.email, subject, text, recipients, fileName, pdfB64 });
  }

  // ---- Stamp the JHA in the user's synced records (never blocks the reply) ----
  try {
    const jhaId = str(s.jhaId, 60);
    if (jhaId) {
      const now = new Date().toISOString();
      const { records } = await getContainers();
      const docId = me.id + ':jha_records';
      let doc = null;
      try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
      if (doc && Array.isArray(doc.data)) {
        const j = doc.data.find((x) => x && x.id === jhaId);
        if (j) {
          j.emailedTo = recipients;
          j.sent = !!mail.sent;
          j.sentTs = now;
          if (pdfBlobPath) j.pdfBlob = pdfBlobPath;
          j.updatedAt = now;
          doc.updatedAt = now;
          await records.items.upsert(doc);
        }
      }
    }
  } catch (e) {
    context.log.error('send-jha record stamp', e);
  }

  if (mail.sent) return json(context, 200, { ok: true, sent: true, recipients: recipients, archived: !!pdfBlobPath, pdfBlob: pdfBlobPath });
  return json(context, 200, { ok: true, sent: false, reason: mail.reason, detail: mail.detail, archived: !!pdfBlobPath, pdfBlob: pdfBlobPath });
};
