// /api/project-files — files inside a Job Book, stored in the private
// 'job-books' blob container, pathed <projectCode>/<fileName>. Every signed-in
// user can list, view, and upload; only admins can delete.
//
// GET    ?project=<code>              -> { files: [{ name, size, lastModified, contentType }] }
// GET    ?project=<code>&name=<file>  -> streams the file
// POST   { project, name, contentType, data } (data = base64 or data URI) -> uploads
// DELETE ?project=<code>&name=<file>  -> admin only
const { getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { getJobBooksContainer, safeName, safeFileName } = require('../shared/blob');

const MAX_FILE_B64 = 40 * 1024 * 1024; // ~30MB real file

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('project-files ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const method = (req.method || 'GET').toUpperCase();
  try {
    const container = await getJobBooksContainer();

    if (method === 'GET') {
      const project = safeName((req.query && req.query.project) || '');
      if (!project) return json(context, 400, { error: 'project required.' });
      const name = safeFileName((req.query && req.query.name) || '');

      if (!name) {
        const files = [];
        for await (const blob of container.listBlobsFlat({ prefix: project + '/' })) {
          files.push({
            name: blob.name.slice(project.length + 1),
            size: blob.properties.contentLength || 0,
            lastModified: blob.properties.lastModified || null,
            contentType: blob.properties.contentType || 'application/octet-stream',
          });
        }
        files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return json(context, 200, { files: files });
      }

      const bc = container.getBlockBlobClient(project + '/' + name);
      if (!(await bc.exists())) return json(context, 404, { error: 'Not found.' });
      const props = await bc.getProperties();
      const buf = await bc.downloadToBuffer();
      context.res = {
        status: 200,
        isRaw: true,
        headers: {
          'Content-Type': props.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=300',
        },
        body: buf,
      };
      return;
    }

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body) return json(context, 400, { error: 'Bad request.' });
      const project = safeName(body.project || '');
      const name = safeFileName(body.name || '');
      if (!project || !name) return json(context, 400, { error: 'project and name required.' });
      let b64 = String(body.data || '');
      if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
      if (b64.length < 4) return json(context, 400, { error: 'Empty file.' });
      if (b64.length > MAX_FILE_B64) return json(context, 400, { error: 'File too large (30MB max).' });
      const contentType = String(body.contentType || 'application/octet-stream').slice(0, 100);
      await container.getBlockBlobClient(project + '/' + name).uploadData(Buffer.from(b64, 'base64'), {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return json(context, 200, { ok: true, name: name });
    }

    if (method === 'DELETE') {
      if (!isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
      const project = safeName((req.query && req.query.project) || '');
      const name = safeFileName((req.query && req.query.name) || '');
      if (!project || !name) return json(context, 400, { error: 'project and name required.' });
      try { await container.getBlockBlobClient(project + '/' + name).delete(); } catch (e) { if (e.statusCode !== 404) throw e; }
      return json(context, 200, { ok: true });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('project-files', e);
    if (/BLOB_CONN/.test(e.message || '')) return json(context, 200, { ok: false, reason: 'blob-not-configured' });
    return json(context, 500, { error: 'Server error.' });
  }
};
