// /api/ewt-pdf — EWT PDFs in Blob Storage (no size budgets, kept forever).
//
// POST { ticketNo, date, pdf } -> uploads the caller's PDF, returns { path }.
// GET  ?user=<id>&name=<file>  -> streams a stored PDF. A user can only fetch
// their own; admins can fetch anyone's (same isolation rules as records).
const { getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { getEwtContainer, safeName } = require('../shared/blob');

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('ewt-pdf ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const method = (req.method || 'GET').toUpperCase();
  try {
    const container = await getEwtContainer();

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body || !body.pdf) return json(context, 400, { error: 'Missing PDF.' });
      let b64 = String(body.pdf);
      if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
      if (b64.length < 100) return json(context, 400, { error: 'PDF too small.' });
      if (b64.length > 8 * 1024 * 1024) return json(context, 400, { error: 'PDF too large.' });
      const name = safeName((body.ticketNo || 'ticket') + '-' + (body.date || 'nodate')) + '-' + Date.now() + '.pdf';
      const path = me.id + '/' + name;
      await container.getBlockBlobClient(path).uploadData(Buffer.from(b64, 'base64'), {
        blobHTTPHeaders: { blobContentType: 'application/pdf' },
      });
      return json(context, 200, { ok: true, path: path });
    }

    if (method === 'GET') {
      const user = String((req.query && req.query.user) || me.id);
      if (user !== me.id && !isAdmin(me)) return json(context, 403, { error: 'Forbidden.' });
      const name = safeName((req.query && req.query.name) || '');
      if (!name) return json(context, 400, { error: 'name required.' });
      const bc = container.getBlockBlobClient(user + '/' + name);
      if (!(await bc.exists())) return json(context, 404, { error: 'Not found.' });
      const buf = await bc.downloadToBuffer();
      context.res = {
        status: 200,
        isRaw: true,
        headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=300' },
        body: buf,
      };
      return;
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('ewt-pdf', e);
    if (/BLOB_CONN/.test(e.message || '')) {
      return json(context, 200, { ok: false, reason: 'blob-not-configured' });
    }
    return json(context, 500, { error: 'Server error.' });
  }
};
