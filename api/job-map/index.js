// /api/job-map — per-job map settings and the geotechnical layer.
//
// One shared doc per project in the records container (id 'map:<code>',
// ownerId '__shared__'). The map itself is drawn in the browser from the
// KMZ/KML files in the job book's Plans folder; this endpoint holds what has
// to be shared: which file is the job's default, the borings an AI read out
// of the geotech report, and where each boring sits on the map.
//
// GET  ?code=            -> { map }  (also moves a background report read along)
// POST { code, mode, … } -> { ok, map }
//   admin only:
//     setDefault  { folder, name }        which KMZ/KML opens first for everyone
//     geoStart    { folder, name }        begin reading a report PDF from the job book
//     geoStep     {}                      do the next slice of preparation (call until status != 'preparing')
//     geoClear    {}                      discard the reading
//     placeBoring { id, lat, lon }        put / move a boring on the map
//     unplaceBoring { id }                back to the report's own coordinates (or unplaced)
//
// Reading a report: geoStart -> geoStep × n (split the PDF into page ranges,
// upload each to the Files API, then submit one Message Batch) -> the batch
// runs at Anthropic -> any GET notices it has ended and saves the borings.
// Every step fits inside the 45-second API limit of Static Web Apps.
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { getJobBooksContainer, safeName, safeFileName } = require('../shared/blob');
const { readDoc, findProject } = require('../shared/projects');
const geo = require('../shared/geotech');

const DOC_PK = '__shared__';
const ADMIN_MODES = new Set(['setDefault', 'geoStart', 'geoStep', 'geoClear', 'placeBoring', 'unplaceBoring']);
const STEP_BUDGET_MS = 24000;      // stop starting new uploads after this
const MAX_REPORT_BYTES = 120 * 1024 * 1024;
const WHOLE_FILE_MAX = 30 * 1024 * 1024;

const mapId = (code) => 'map:' + safeName(String(code).toLowerCase());
const who = (me) => ({ email: me.email, name: me.name || me.email });
const blobPath = (code, folder, name) => code + '/' + (folder ? folder + '/' : '') + name;

function emptyMap(code) {
  return { id: mapId(code), ownerId: DOC_PK, type: 'project_map', code, defaultFile: null, geotech: null, placements: {}, updatedAt: '' };
}

// What the browser gets: no file ids or batch ids, borings with their final spot.
function publicMap(doc) {
  const g = doc.geotech;
  const out = { code: doc.code, defaultFile: doc.defaultFile || null, geotech: null, updatedAt: doc.updatedAt || '' };
  if (!g) return out;
  const chunks = Array.isArray(g.chunks) ? g.chunks : [];
  const placements = doc.placements || {};
  out.geotech = {
    status: g.status, file: g.file || null, pageCount: g.pageCount || 0,
    prepared: chunks.filter((c) => c.fileId).length, parts: chunks.length,
    startedBy: g.startedBy || null, startedAt: g.startedAt || '', finishedAt: g.finishedAt || '',
    error: g.error || '', warnings: Array.isArray(g.warnings) ? g.warnings : [],
    report: g.report || null, planPages: g.planPages || [],
    borings: (Array.isArray(g.borings) ? g.borings : []).map((b) => {
      const p = placements[b.id];
      const o = Object.assign({}, b);
      o.reportLat = b.lat; o.reportLon = b.lon;
      if (p) { o.lat = p.lat; o.lon = p.lon; o.placed = 'manual'; o.placedBy = p.by || ''; }
      else o.placed = b.lat != null && b.lon != null ? 'report' : '';
      return o;
    }),
  };
  return out;
}

async function readMap(records, code) {
  try { return (await records.item(mapId(code), DOC_PK).read()).resource || null; } catch (e) { if (e.code !== 404) throw e; return null; }
}
// Etag-checked read-modify-write; fn returns { error, status } to abort.
async function updateMap(records, code, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await readMap(records, code);
    const doc = existing || emptyMap(code);
    const r = fn(doc) || {};
    if (r.error) return r;
    doc.updatedAt = new Date().toISOString();
    if (JSON.stringify(doc).length > 1.6 * 1024 * 1024) return { error: 'The map record is too large to save.', status: 409 };
    try {
      if (existing) await records.item(doc.id, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: existing._etag } });
      else await records.items.create(doc);
      return { doc };
    } catch (e) {
      if (e.code !== 412 && e.code !== 409) throw e;   // raced another writer — retry
    }
  }
  return { error: 'The map was busy — try again.', status: 409 };
}

// ---- background read: preparation step ----
// The opened report is kept for the next step on a warm instance, so a big
// PDF is downloaded and parsed once rather than on every step.
let warm = null;   // { key, buffer, pdf, pages, loadError }
function dropWarm() { if (warm && warm.pdf) warm.pdf.close(); warm = null; }
async function openReport(context, code, g) {
  const key = code + '|' + g.file.folder + '|' + g.file.name + '|' + g.startedAt;
  if (warm && warm.key === key) return warm;
  dropWarm();
  const container = await getJobBooksContainer();
  const bc = container.getBlockBlobClient(blobPath(code, g.file.folder, g.file.name));
  if (!(await bc.exists())) return { missing: true };
  const buffer = await bc.downloadToBuffer();
  const out = { key, buffer, pdf: null, pages: 0, loadError: '', password: false };
  try { out.pdf = await geo.openPdf(buffer, 22000); out.pages = out.pdf.pages; }
  catch (e) {
    out.pdf = null; out.pages = 0; out.password = e && e.code === 'PDF_PASSWORD';
    out.loadError = (e && e.message) || String(e);
    context.log.warn('job-map pdf load: ' + out.loadError);
  }
  warm = out;
  return out;
}

async function geoStep(context, records, code) {
  const started = Date.now();
  const doc = await readMap(records, code);
  const g = doc && doc.geotech;
  if (!g || g.status !== 'preparing') { dropWarm(); return { doc: doc || emptyMap(code) }; }
  const fail = (msg) => { dropWarm(); return updateMap(records, code, (d) => { if (d.geotech) { d.geotech.status = 'failed'; d.geotech.error = msg; d.geotech.finishedAt = new Date().toISOString(); } }); };
  // Anything unexpected is written onto the reading (so the screen says why) instead of a bare 500.
  const stall = (msg) => updateMap(records, code, (d) => {
    const cur = d.geotech;
    if (!cur || cur.status !== 'preparing' || cur.startedAt !== g.startedAt) return;
    cur.stalls = (cur.stalls || 0) + 1; cur.error = msg;
    if (cur.stalls >= 3) { cur.status = 'failed'; cur.finishedAt = new Date().toISOString(); dropWarm(); }
  });

  let report;
  try { report = await openReport(context, code, g); }
  catch (e) { context.log.error('job-map open report', e); return stall('Could not open the report: ' + ((e && e.message) || e)); }
  if (report.missing) return fail('The report file is no longer in the job book.');
  if (report.password) return fail('This PDF needs a password to open. Save an unlocked copy, put that in the job book and read it instead.');
  const buffer = report.buffer, pdf = report.pdf;

  let chunks = Array.isArray(g.chunks) ? g.chunks.map((c) => Object.assign({}, c)) : [];
  let pageCount = g.pageCount || 0;
  if (!chunks.length) {
    if (pdf) {
      pageCount = report.pages;
      if (!pageCount) return fail('That PDF has no pages.');
      if (pageCount > geo.MAX_PAGES) return fail('That report is ' + pageCount + ' pages — the limit is ' + geo.MAX_PAGES + '. Upload just the boring logs as their own PDF.');
      chunks = geo.splitPlan(pageCount).map((c) => ({ from: c.from, to: c.to, fileId: '' }));
    } else {
      // Could not take the PDF apart (odd or protected file): send it whole if it is small enough.
      if (buffer.length > WHOLE_FILE_MAX) return fail('This PDF could not be split into pages (' + report.loadError.slice(0, 160) + ') and is too large to read whole. Re-save it with Print to PDF and try again.');
      chunks = [{ from: 1, to: 1, fileId: '', whole: true }];
      pageCount = 0;
    }
  }

  let stepError = '';
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.fileId) continue;
    if (Date.now() - started > STEP_BUDGET_MS) break;
    try {
      if (!c.whole && !pdf) throw new Error('the PDF could not be opened (' + report.loadError.slice(0, 160) + ')');
      const bytes = c.whole ? buffer : await pdf.extract(c.from, c.to);
      c.fileId = await geo.uploadPdf(bytes, 'geotech-' + safeName(code) + '-p' + c.from + '-' + c.to + '.pdf', 32000 - Math.min(20000, Date.now() - started));
    } catch (e) {
      stepError = e.message || String(e);
      context.log.warn('job-map upload pages ' + c.from + '-' + c.to + ': ' + stepError);
      break;
    }
  }

  let batchId = '', shape = g.shape || 0;
  const ready = chunks.every((c) => c.fileId);
  if (ready && !stepError && Date.now() - started < 30000) {
    try { batchId = await geo.createBatch(chunks, pageCount || 1, g.file.name, shape); }
    catch (e) {
      // A 400 on the first request shape: try once more in plain-JSON form.
      if (e.status === 400 && shape === 0 && Date.now() - started < 34000) {
        try { shape = 1; batchId = await geo.createBatch(chunks, pageCount || 1, g.file.name, shape); } catch (e2) { stepError = e2.message || String(e2); }
      } else stepError = e.message || String(e);
    }
  }
  // A step that made no headway at all three times running is a real failure, not a hiccup.
  const progressed = chunks.filter((c) => c.fileId).length > (Array.isArray(g.chunks) ? g.chunks.filter((c) => c.fileId).length : 0) || !!batchId;
  return updateMap(records, code, (d) => {
    const cur = d.geotech;
    if (!cur || cur.status !== 'preparing' || cur.startedAt !== g.startedAt) return;   // cleared or restarted meanwhile
    cur.chunks = chunks; cur.pageCount = pageCount; cur.shape = shape;
    cur.stalls = progressed ? 0 : (cur.stalls || 0) + 1;
    cur.error = stepError;
    if (batchId) { cur.status = 'reading'; cur.batchId = batchId; cur.submittedAt = new Date().toISOString(); cur.checkedAt = ''; cur.error = ''; dropWarm(); }
    else if (cur.stalls >= 3) { cur.status = 'failed'; cur.error = stepError || 'Could not prepare the report.'; cur.finishedAt = new Date().toISOString(); dropWarm(); }
  });
}

// ---- background read: has the batch finished? ----
async function geoPoll(context, records, code, doc) {
  const g = doc.geotech;
  if (!g || g.status !== 'reading' || !g.batchId) return doc;
  if (g.checkedAt && Date.now() - Date.parse(g.checkedAt) < 8000) return doc;
  let batch;
  try { batch = await geo.getBatch(g.batchId); }
  catch (e) { context.log.warn('job-map batch check: ' + (e.message || e)); return doc; }
  if (batch.processing_status !== 'ended') {
    const r = await updateMap(records, code, (d) => { if (d.geotech && d.geotech.batchId === g.batchId) d.geotech.checkedAt = new Date().toISOString(); });
    return r.doc || doc;
  }
  let results;
  try { results = (await geo.getResults(batch)).map(geo.readResult); }
  catch (e) { context.log.warn('job-map batch results: ' + (e.message || e)); return doc; }

  // Every page range rejected as a bad request on the schema-constrained shape: resubmit once in plain-JSON form.
  if ((g.shape || 0) === 0 && results.length && results.every((r) => r.invalid)) {
    try {
      const batchId = await geo.createBatch(g.chunks, g.pageCount || 1, g.file.name, 1);
      const r = await updateMap(records, code, (d) => { if (d.geotech && d.geotech.batchId === g.batchId) { d.geotech.batchId = batchId; d.geotech.shape = 1; d.geotech.checkedAt = ''; } });
      return r.doc || doc;
    } catch (e) { context.log.warn('job-map resubmit: ' + (e.message || e)); }
  }

  const merged = geo.mergeResults(g.chunks, results);
  const missing = g.chunks.length - results.length;
  if (missing > 0) merged.warnings.push(missing + ' page range' + (missing === 1 ? '' : 's') + ' returned nothing');
  const allFailed = results.length > 0 && results.every((r) => r.error);
  const now = new Date().toISOString();
  const r = await updateMap(records, code, (d) => {
    const cur = d.geotech;
    if (!cur || cur.batchId !== g.batchId) return;
    cur.status = allFailed || !results.length ? 'failed' : 'done';
    cur.error = cur.status === 'failed' ? (merged.warnings[0] || 'The report could not be read.') : '';
    cur.warnings = merged.warnings.slice(0, 20);
    cur.report = merged.report; cur.planPages = merged.planPages; cur.borings = merged.borings;
    cur.finishedAt = now; cur.batchId = ''; cur.checkedAt = now;
    cur.chunks = cur.chunks.map((c) => ({ from: c.from, to: c.to, fileId: '' }));
  });
  // The page-range uploads have done their job — remove them (best effort).
  await Promise.all(g.chunks.filter((c) => c.fileId).slice(0, 40).map((c) => geo.deleteFile(c.fileId)));
  return r.doc || doc;
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });
  let me;
  try { me = await ensureUser(principal, principal.email); }
  catch (e) { context.log.error('job-map ensureUser', e); return json(context, 500, { error: 'Server error.' }); }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const method = (req.method || 'GET').toUpperCase();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const rawCode = method === 'GET' ? (req.query && req.query.code) : (body && body.code);
  if (!rawCode) return json(context, 400, { error: 'code required.' });

  try {
    const { records } = await getContainers();
    const p = findProject(await readDoc(records), rawCode);
    if (!p) return json(context, 404, { error: 'Project not found.' });
    const code = p.code;

    if (method === 'GET') {
      let doc = (await readMap(records, code)) || emptyMap(code);
      if (doc.geotech && doc.geotech.status === 'reading') {
        try { doc = await geoPoll(context, records, code, doc); } catch (e) { context.log.warn('job-map poll: ' + (e.message || e)); }
      }
      return json(context, 200, { map: publicMap(doc) });
    }
    if (method !== 'POST') return json(context, 405, { error: 'Method not allowed.' });
    if (!body || typeof body !== 'object') return json(context, 400, { error: 'Bad request.' });
    const mode = String(body.mode || '');
    if (!ADMIN_MODES.has(mode)) return json(context, 400, { error: 'Unknown mode.' });
    if (!isAdmin(me)) return json(context, 403, { error: 'Only an admin can change the job map.' });

    const now = new Date().toISOString();
    let r;
    if (mode === 'setDefault') {
      const name = safeFileName(body.name || ''), folder = safeFileName(body.folder || '');
      if (!/\.(kmz|kml)$/i.test(name)) return json(context, 400, { error: 'Pick a KMZ or KML file.' });
      r = await updateMap(records, code, (d) => { d.defaultFile = { folder, name, by: who(me), at: now }; });
    } else if (mode === 'geoStart') {
      const name = safeFileName(body.name || ''), folder = safeFileName(body.folder || '');
      if (!/\.pdf$/i.test(name)) return json(context, 400, { error: 'The report has to be a PDF.' });
      if (!process.env.ANTHROPIC_API_KEY) return json(context, 500, { error: 'The AI key (ANTHROPIC_API_KEY) is not configured on the server.' });
      const container = await getJobBooksContainer();
      const bc = container.getBlockBlobClient(blobPath(code, folder, name));
      if (!(await bc.exists())) return json(context, 404, { error: 'That file is not in the job book.' });
      const size = (await bc.getProperties()).contentLength || 0;
      if (size > MAX_REPORT_BYTES) return json(context, 400, { error: 'That PDF is too large to read (' + Math.round(size / 1048576) + ' MB).' });
      r = await updateMap(records, code, (d) => {
        const cur = d.geotech;
        // A read in flight is paid for — it has to be cancelled on purpose, not overwritten by a second tap.
        if (cur && cur.status === 'reading') return { error: 'A report is already being read for this job. Cancel it first to start over.', status: 409 };
        if (cur && cur.status === 'preparing' && Date.now() - Date.parse(cur.startedAt || 0) < 3 * 60 * 1000) return { error: 'A report is already being prepared for this job.', status: 409 };
        d.geotech = { status: 'preparing', file: { folder, name, size }, pageCount: 0, chunks: [], shape: 0, stalls: 0, batchId: '', startedBy: who(me), startedAt: now,
          checkedAt: '', finishedAt: '', error: '', warnings: [], report: null, planPages: [], borings: [] };
      });
    } else if (mode === 'geoStep') {
      try { r = await geoStep(context, records, code); }
      catch (e) {
        context.log.error('job-map geoStep', e);
        return json(context, 500, { error: 'Could not prepare the report: ' + String((e && e.message) || e).slice(0, 300) });
      }
    } else if (mode === 'geoClear') {
      r = await updateMap(records, code, (d) => { d.geotech = null; });
    } else if (mode === 'placeBoring' || mode === 'unplaceBoring') {
      const id = String(body.id || '').slice(0, 40);
      const lat = Number(body.lat), lon = Number(body.lon);
      if (mode === 'placeBoring' && !(isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return json(context, 400, { error: 'Bad location.' });
      r = await updateMap(records, code, (d) => {
        const list = (d.geotech && Array.isArray(d.geotech.borings)) ? d.geotech.borings : [];
        if (!list.some((b) => b.id === id)) return { error: 'That boring is not on this job.', status: 404 };
        d.placements = d.placements || {};
        if (mode === 'placeBoring') d.placements[id] = { lat: Math.round(lat * 1e7) / 1e7, lon: Math.round(lon * 1e7) / 1e7, by: me.name || me.email, at: now };
        else delete d.placements[id];
      });
    }
    if (r.error) return json(context, r.status || 400, { error: r.error });
    return json(context, 200, { ok: true, map: publicMap(r.doc) });
  } catch (e) {
    context.log.error('job-map', e);
    // Admins see the reason — they are the ones who have to act on it.
    return json(context, 500, { error: 'Server error.' + (e && e.message && (isAdmin(me) || /ANTHROPIC|Claude API/.test(e.message)) ? ' ' + String(e.message).slice(0, 300) : '') });
  }
};
