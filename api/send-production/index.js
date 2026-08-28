// POST /api/send-production — email a cost-free production report IMAGE
// (Cost Per Yard or Flat Work) from the signed-in user's own mailbox and
// archive a copy, same mechanism as EWT / Load Count / JHA sends. The image
// carries equipment, hours, and yardage only — the client never includes
// rates or costs.
//
// Body: { subject, text, recipients[], fileName, png (data URI or base64),
//         kind ('cpy'|'flat'), date }
// Reply: { ok:true, sent:true|false, reason?, archived:bool }
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
    context.log.error('send-production ensureUser', e);
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
  const subject = String(body.subject || 'EBCC Production Report').slice(0, 150);
  const text = String(body.text || '').slice(0, 20000);
  const fileName = String(body.fileName || 'Production.png').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80) || 'Production.png';
  const kind = body.kind === 'flat' ? 'flat' : 'cpy';
  let pngB64 = String(body.png || '');
  if (pngB64.startsWith('data:')) pngB64 = pngB64.slice(pngB64.indexOf(',') + 1);
  if (!pngB64 || pngB64.length < 100) return json(context, 400, { ok: false, error: 'Missing image.' });
  if (pngB64.length > 6 * 1024 * 1024) return json(context, 400, { ok: false, error: 'Image too large.' });

  // ---- Archive the image (same private container as the other sends) ----
  let blobPath = '';
  try {
    const container = await getEwtContainer();
    const name = 'production-' + kind + '-' + safeName(String(body.date || '').slice(0, 20) || 'nodate') + '-' + Date.now() + '.png';
    blobPath = me.id + '/' + name;
    await container.getBlockBlobClient(blobPath).uploadData(Buffer.from(pngB64, 'base64'), {
      blobHTTPHeaders: { blobContentType: 'image/png' },
    });
  } catch (e) {
    context.log.warn('send-production blob upload failed: ' + (e.message || e));
    blobPath = '';
  }

  // ---- Email it (only when recipients were picked) ----
  let mail = { ok: false, reason: 'no-recipients' };
  if (recipients.length) {
    mail = await sendGraphMail(context, {
      fromEmail: me.email, subject, text, recipients, fileName,
      pdfB64: pngB64, contentType: 'image/png',
    });
  }

  // ---- Record the send (never blocks the reply): the moved-so-far /
  // remaining tiles on future reports sum these per project + day.
  try {
    const str = (v, n) => String(v == null ? '' : v).slice(0, n || 120);
    const now = new Date().toISOString();
    const rec = {
      ts: now,
      date: str(body.date, 20),
      kind: kind,
      projectCode: str(body.projectCode, 40),
      projectName: str(body.projectName, 120),
      amount: isFinite(+body.amount) ? Math.round(+body.amount) : 0,
      emailedTo: recipients,
      sent: !!mail.sent,
      pdfBlob: blobPath,
    };
    const { records, users } = await getContainers();
    const docId = me.id + ':production_sends';
    let doc = null;
    try { doc = (await records.item(docId, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
    let arr = (doc && Array.isArray(doc.data)) ? doc.data : [];
    arr.push(rec);
    if (arr.length > 300) arr = arr.slice(arr.length - 300);
    await records.items.upsert({ id: docId, ownerId: me.id, ownerEmail: me.email, type: 'production_sends', data: arr, updatedAt: now });
    me.counts = me.counts || {};
    me.counts.production_sends = arr.length;
    me.lastActiveAt = now;
    await users.items.upsert(me);
  } catch (e) {
    context.log.error('send-production record', e);
  }

  if (mail.sent) return json(context, 200, { ok: true, sent: true, recipients: recipients, archived: !!blobPath });
  return json(context, 200, { ok: true, sent: false, reason: mail.reason, detail: mail.detail, archived: !!blobPath });
};
