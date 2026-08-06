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
const { BlobSASPermissions } = require('@azure/storage-blob');

const MAX_SINGLE_B64 = 12 * 1024 * 1024; // small files come up in one shot (~9MB real)
const MAX_CHUNK_B64 = 8 * 1024 * 1024;   // large files arrive as staged 4MB blocks

// Extension-first MIME lookup. iPhones/iPads can only QuickLook Office files
// when they arrive with the real type — application/octet-stream shows a
// blank page — and stored blob types are unreliable (some browsers upload
// xlsx with an empty type).
const EXT_TYPES = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', heic: 'image/heic',
  kmz: 'application/vnd.google-earth.kmz',
  kml: 'application/vnd.google-earth.kml+xml',
  zip: 'application/zip',
};
function typeFor(name, stored) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return EXT_TYPES[ext] || stored || 'application/octet-stream';
}

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
      const folder = safeFileName((req.query && req.query.folder) || '');

      if (!name) {
        // List: files may live at the project root ('' = Unsorted) or one folder deep.
        const files = [];
        for await (const blob of container.listBlobsFlat({ prefix: project + '/' })) {
          const rest = blob.name.slice(project.length + 1);
          const slash = rest.indexOf('/');
          files.push({
            name: slash >= 0 ? rest.slice(slash + 1) : rest,
            folder: slash >= 0 ? rest.slice(0, slash) : '',
            size: blob.properties.contentLength || 0,
            lastModified: blob.properties.lastModified || null,
            contentType: blob.properties.contentType || 'application/octet-stream',
          });
        }
        files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return json(context, 200, { files: files });
      }

      const bc = container.getBlockBlobClient(project + '/' + (folder ? folder + '/' : '') + name);
      if (!(await bc.exists())) return json(context, 404, { error: 'Not found.' });

      // Preferred: hand back a short-lived read link so the browser pulls the
      // file straight from storage — no size ceiling, no function bandwidth.
      if (req.query && req.query.sas) {
        try {
          const url = await bc.generateSasUrl({
            permissions: BlobSASPermissions.parse('r'),
            expiresOn: new Date(Date.now() + 15 * 60 * 1000),
            // Override response headers so iOS QuickLook gets the real type
            contentType: typeFor(name),
            contentDisposition: 'inline; filename="' + name.replace(/["\\]/g, '') + '"',
          });
          return json(context, 200, { ok: true, url: url });
        } catch (e) {
          context.log.warn('sas generation failed: ' + (e.message || e));
          // fall through to streaming below
        }
      }

      const props = await bc.getProperties();
      const buf = await bc.downloadToBuffer();
      context.res = {
        status: 200,
        isRaw: true,
        headers: {
          'Content-Type': typeFor(name, props.contentType),
          'Content-Disposition': 'inline; filename="' + name.replace(/["\\]/g, '') + '"',
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
      const folder = safeFileName(body.folder || '');
      const mode = String(body.mode || 'single');
      const contentType = String(body.contentType || 'application/octet-stream').slice(0, 100);

      // Move a file between folders: server-side copy, then delete the source.
      if (mode === 'move') {
        const from = safeFileName(body.from || '');
        const to = safeFileName(body.to || '');
        const src = container.getBlockBlobClient(project + '/' + (from ? from + '/' : '') + name);
        const dst = container.getBlockBlobClient(project + '/' + (to ? to + '/' : '') + name);
        if (!(await src.exists())) return json(context, 404, { error: 'File not found.' });
        if (await dst.exists()) return json(context, 409, { error: 'A file with that name is already there.' });
        const srcUrl = await src.generateSasUrl({
          permissions: BlobSASPermissions.parse('r'),
          expiresOn: new Date(Date.now() + 10 * 60 * 1000),
        });
        await dst.syncCopyFromURL(srcUrl);
        await src.delete();
        return json(context, 200, { ok: true });
      }

      const bc = container.getBlockBlobClient(project + '/' + (folder ? folder + '/' : '') + name);

      // Large files arrive as staged blocks, then a commit assembles them.
      if (mode === 'stage') {
        const blockId = String(body.blockId || '');
        if (!/^[A-Za-z0-9+/=]{8,128}$/.test(blockId)) return json(context, 400, { error: 'Bad blockId.' });
        let b64 = String(body.data || '');
        if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
        if (b64.length < 4) return json(context, 400, { error: 'Empty block.' });
        if (b64.length > MAX_CHUNK_B64) return json(context, 400, { error: 'Block too large.' });
        const buf = Buffer.from(b64, 'base64');
        await bc.stageBlock(blockId, buf, buf.length);
        return json(context, 200, { ok: true });
      }
      if (mode === 'commit') {
        const blockIds = Array.isArray(body.blockIds) ? body.blockIds.map(String) : [];
        if (!blockIds.length || blockIds.length > 200) return json(context, 400, { error: 'Bad block list.' });
        await bc.commitBlockList(blockIds, { blobHTTPHeaders: { blobContentType: contentType } });
        return json(context, 200, { ok: true, name: name });
      }

      // Small files: single shot
      let b64 = String(body.data || '');
      if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
      if (b64.length < 4) return json(context, 400, { error: 'Empty file.' });
      if (b64.length > MAX_SINGLE_B64) return json(context, 400, { error: 'Too large for single upload — use staged blocks.' });
      await bc.uploadData(Buffer.from(b64, 'base64'), {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return json(context, 200, { ok: true, name: name });
    }

    if (method === 'DELETE') {
      if (!isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
      const project = safeName((req.query && req.query.project) || '');
      const name = safeFileName((req.query && req.query.name) || '');
      const folder = safeFileName((req.query && req.query.folder) || '');
      if (!project || !name) return json(context, 400, { error: 'project and name required.' });
      try { await container.getBlockBlobClient(project + '/' + (folder ? folder + '/' : '') + name).delete(); } catch (e) { if (e.statusCode !== 404) throw e; }
      return json(context, 200, { ok: true });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('project-files', e);
    if (/BLOB_CONN/.test(e.message || '')) return json(context, 200, { ok: false, reason: 'blob-not-configured' });
    return json(context, 500, { error: 'Server error.' });
  }
};
