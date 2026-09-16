// POST /api/send-toolbox — email a submitted Tailgate Talk (attendance record) PDF from the
// signed-in user's own mailbox and archive a copy for the office. Amber
// (safety) is always on the recipient list — enforced here, not just in
// the app — and the matching report in toolbox_records is stamped.
//
// Body: { subject, text, recipients[], fileName, pdf (data URI or base64),
//         summary: { recordId, date, projectCode, projectName, type } }
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
    context.log.error('send-toolbox ensureUser', e);
    return json(context, 500, { ok: false, error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { ok: false, error: 'Account disabled.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return json(context, 400, { ok: false, error: 'Bad request.' });

  const recipients = Array.from(new Set(ALWAYS_TO.concat(
    (Array.isArray(body.recipients) ? body.recipients : []).map((r) => String(r).trim().toLowerCase())
  ))).filter((r) => EMAIL_RE.test(r)).slice(0, 20);
  const subject = String(body.subject || 'EBCC Tailgate Talk').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'ToolboxTalk.pdf').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'ToolboxTalk.pdf';
  let pdfB64 = String(body.pdf || '');
  if (pdfB64.startsWith('data:')) pdfB64 = pdfB64.slice(pdfB64.indexOf(',') + 1);
  if (!pdfB64 || pdfB64.length < 100) return json(context, 400, { ok: false, error: 'Missing PDF.' });
  if (pdfB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'PDF too large.' });
  const s = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);

  // ---- Archive the PDF + any new photos (same private container as the other sends) ----
  const stamp = Date.now();
  const base = 'toolbox-' + safeName(str(s.projectCode, 30) || 'noproj') + '-' + safeName(str(s.date, 20) || 'nodate') + '-' + stamp;
  let pdfBlobPath = '';
  let container = null;
  try {
    container = await getEwtContainer();
    pdfBlobPath = me.id + '/' + base + '.pdf';
    await container.getBlockBlobClient(pdfBlobPath).uploadData(Buffer.from(pdfB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
  } catch (e) {
    context.log.warn('send-toolbox blob upload failed: ' + (e.message || e));
    pdfBlobPath = '';
    container = null;
  }
  // Photos: `photos` are new originals (data URIs) to archive; `photoBlobs`
  // are paths already archived by an earlier send — re-attached from the store.
  const newPhotos = [];
  (Array.isArray(body.photos) ? body.photos : []).slice(0, 12).forEach((v, i) => {
    let d = String(v || ''); let type = 'image/jpeg';
    if (d.startsWith('data:')) { const c = d.indexOf(','); type = d.slice(5, c).split(';')[0] || type; d = d.slice(c + 1); }
    if (d.length < 100 || d.length > 6 * 1024 * 1024) return;
    if (type !== 'image/png') type = 'image/jpeg';
    newPhotos.push({ b64: d, type, name: base + '-' + (i + 1) + (type === 'image/png' ? '.png' : '.jpg') });
  });
  const photoBlobs = (Array.isArray(body.photoBlobs) ? body.photoBlobs : [])
    .map((x) => String(x || '')).filter((x) => x.startsWith(me.id + '/')).slice(0, 12)
    .map((path) => ({ path }));
  const attachments = [];
  const MAIL_B64_BUDGET = 3.6 * 1024 * 1024;
  let used = pdfB64.length;
  if (container) {
    for (const ph of newPhotos) {
      try {
        const path = me.id + '/' + ph.name;
        await container.getBlockBlobClient(path).uploadData(Buffer.from(ph.b64, 'base64'), { blobHTTPHeaders: { blobContentType: ph.type } });
        photoBlobs.push({ path });
      } catch (e) { context.log.warn('send-toolbox photo upload failed: ' + (e.message || e)); }
      if (used + ph.b64.length <= MAIL_B64_BUDGET) { attachments.push({ name: 'Photo-' + (attachments.length + 1) + (ph.type === 'image/png' ? '.png' : '.jpg'), contentType: ph.type, b64: ph.b64 }); used += ph.b64.length; }
    }
    // Re-sends: pull previously archived originals back out for the email.
    for (const pb of photoBlobs) {
      if (newPhotos.some((ph) => me.id + '/' + ph.name === pb.path)) continue;
      try {
        const bc = container.getBlockBlobClient(pb.path);
        if (!(await bc.exists())) continue;
        const b64 = (await bc.downloadToBuffer()).toString('base64');
        if (used + b64.length > MAIL_B64_BUDGET) break;
        attachments.push({ name: 'Photo-' + (attachments.length + 1) + (/\.png$/i.test(pb.path) ? '.png' : '.jpg'), contentType: /\.png$/i.test(pb.path) ? 'image/png' : 'image/jpeg', b64 });
        used += b64.length;
      } catch (e) { context.log.warn('send-toolbox photo fetch failed: ' + (e.message || e)); }
    }
  } else {
    // No store: still attach the new originals we were handed.
    for (const ph of newPhotos) {
      if (used + ph.b64.length > MAIL_B64_BUDGET) break;
      attachments.push({ name: 'Photo-' + (attachments.length + 1) + (ph.type === 'image/png' ? '.png' : '.jpg'), contentType: ph.type, b64: ph.b64 });
      used += ph.b64.length;
    }
  }

  // ---- Email it ----
  const mail = await sendGraphMail(context, { fromEmail: me.email, subject, text, recipients, fileName, pdfB64, attachments });

  // ---- Stamp the report in the user's synced records (never blocks the reply) ----
  try {
    const recordId = str(s.recordId, 60);
    if (recordId) {
      const now = new Date().toISOString();
      const { records } = await getContainers();
      const docId = me.id + ':toolbox_records';
      let doc = null;
      try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
      if (doc && Array.isArray(doc.data)) {
        const r = doc.data.find((x) => x && x.id === recordId);
        if (r) {
          r.emailedTo = recipients;
          r.sent = !!mail.sent;
          r.sentTs = now;
          if (pdfBlobPath) r.pdfBlob = pdfBlobPath;
          if (photoBlobs.length) r.photoBlobs = photoBlobs;
          r.updatedAt = now;
          doc.updatedAt = now;
          await records.items.upsert(doc);
        }
      }
    }
  } catch (e) {
    context.log.error('send-toolbox record stamp', e);
  }

  const out = { ok: true, recipients, archived: !!pdfBlobPath, pdfBlob: pdfBlobPath, photoBlobs, photosArchived: photoBlobs.length, photosAttached: attachments.length };
  if (mail.sent) return json(context, 200, Object.assign(out, { sent: true }));
  return json(context, 200, Object.assign(out, { sent: false, reason: mail.reason, detail: mail.detail }));
};
