// POST /api/send-incident — email a submitted Incident Report PDF from the
// signed-in user's own mailbox and archive a copy for the office. Amber
// (safety) is always on the recipient list — enforced here, not just in
// the app — and the matching report in incident_reports is stamped.
//
// Body: { subject, text, recipients[], fileName, pdf (data URI or base64),
//         summary: { reportId, date, projectCode, projectName, type } }
// Reply: { ok:true, sent:true|false, reason?, recipients, archived:bool, pdfBlob }
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');
const { getEwtContainer, safeName } = require('../shared/blob');
const { sendGraphMail } = require('../shared/mail');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALWAYS_TO = ['amber@earthbasics.net'];

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('send-incident ensureUser', e);
    return json(context, 500, { ok: false, error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { ok: false, error: 'Account disabled.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return json(context, 400, { ok: false, error: 'Bad request.' });

  const recipients = Array.from(new Set(ALWAYS_TO.concat(
    (Array.isArray(body.recipients) ? body.recipients : []).map((r) => String(r).trim().toLowerCase())
  ))).filter((r) => EMAIL_RE.test(r)).slice(0, 20);
  const subject = String(body.subject || 'EBCC Incident Report').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'Incident_Report.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'Incident_Report.pdf';
  let pdfB64 = String(body.pdf || '');
  if (pdfB64.startsWith('data:')) pdfB64 = pdfB64.slice(pdfB64.indexOf(',') + 1);
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });
  const s = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);

  // ---- Archive the PDF (same private container as the other sends) ----
  let pdfBlobPath = '';
  try {
    const container = await getEwtContainer();
    const name = 'incident-' + safeName(str(s.projectCode, 30) || 'noproj') + '-' + safeName(str(s.date, 20) || 'nodate') + '-' + Date.now() + '.pdf';
    pdfBlobPath = me.id + '/' + name;
    await container.getBlockBlobClient(pdfBlobPath).uploadData(Buffer.from(pdfB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
  } catch (e) {
    context.log.warn('send-incident blob upload failed: ' + (e.message || e));
    pdfBlobPath = '';
  }

  // ---- Email it ----
  const mail = await sendGraphMail(context, { fromEmail: me.email, subject, text, recipients, fileName, pdfB64 });

  // ---- Stamp the report in the user's synced records (never blocks the reply) ----
  try {
    const reportId = str(s.reportId, 60);
    if (reportId) {
      const now = new Date().toISOString();
      const { records } = await getContainers();
      const docId = me.id + ':incident_reports';
      let doc = null;
      try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
      if (doc && Array.isArray(doc.data)) {
        const r = doc.data.find((x) => x && x.id === reportId);
        if (r) {
          r.emailedTo = recipients;
          r.sent = !!mail.sent;
          r.sentTs = now;
          if (pdfBlobPath) r.pdfBlob = pdfBlobPath;
          r.updatedAt = now;
          doc.updatedAt = now;
          await records.items.upsert(doc);
        }
      }
    }
  } catch (e) {
    context.log.error('send-incident record stamp', e);
  }

  if (mail.sent) return json(context, 200, { ok: true, sent: true, recipients, archived: !!pdfBlobPath, pdfBlob: pdfBlobPath });
  return json(context, 200, { ok: true, sent: false, reason: mail.reason, detail: mail.detail, recipients, archived: !!pdfBlobPath, pdfBlob: pdfBlobPath });
};
