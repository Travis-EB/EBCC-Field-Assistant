// /api/job-map — per-job map settings and the geotechnical layer.
//
// One shared doc per project in the records container (id 'map:<code>',
// ownerId '__shared__'). The map itself is drawn in the browser from the
// KMZ/KML files in the job book's Plans folder; this endpoint holds what has
// to be shared: which file is the job's default, the borings an AI read out
// of the geotech report, and where each boring sits on the map.
//
// GET  ?code=            -> { map }  (also moves a background report read along)
// GET  ?code=&planPage=N -> one page of the geotech report as a PDF (ADMIN) — the
//                           browser renders it into the boring location plan image
// POST { code, mode, … } -> { ok, map }
//   admin only:
//     setDefault  { folder, name }        which KMZ/KML opens first for everyone
//     geoStart    { folder, name }        begin reading a report PDF from the job book
//     geoStep     {}                      do the next slice of preparation (call until status != 'preparing')
//     geoClear    {}                      discard the reading
//     placeBoring { id, lat, lon }        put / move a boring on the map
//     unplaceBoring { id }                back to the report's own coordinates (or unplaced)
//     setPlan     { folder, name, page, w, h, pts:[{x,y,lat,lon}×2] }
//                                         the boring location plan image (a JPG in the job book) and the
//                                         two points that pin it to the ground
//                                         every saved page is kept (doc.plans, one per report page)
//     clearPlan   { id }                  take ONE saved plan page off the map
//     planLocate  { stage:'coarse', image:{data,w,h}, ids[] } | { stage:'refine', crops:[{id,data,w,h}] }
//                                         ask the AI where borings are drawn on the plan -> { ok, results } (saves nothing)
//     placeBorings { items:[{id,lat,lon}], auto }   several borings at once (auto = found on the plan by the AI)
//
// Reading a report: geoStart -> geoStep × n (split the PDF into page ranges,
// upload each to the Files API, then submit one Message Batch) -> the batch
// runs at Anthropic -> any GET notices it has ended and saves the borings.
// Every step fits inside the 45-second API limit of Static Web Apps.
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { getJobBooksContainer, safeName, safeFileName } = require('../shared/blob');
const { readDoc, findProject } = require('../shared/projects');
const geo = require('../shared/geotech');
const planLocate = require('../shared/planLocate');

const DOC_PK = '__shared__';
const ADMIN_MODES = new Set(['setDefault', 'geoStart', 'geoStep', 'geoClear', 'placeBoring', 'unplaceBoring', 'setPlan', 'clearPlan', 'planLocate', 'placeBorings']);
const STEP_BUDGET_MS = 24000;      // stop starting new uploads after this
const MAX_REPORT_BYTES = 120 * 1024 * 1024;
const WHOLE_FILE_MAX = 30 * 1024 * 1024;

const mapId = (code) => 'map:' + safeName(String(code).toLowerCase());
const who = (me) => ({ email: me.email, name: me.name || me.email });
const blobPath = (code, folder, name) => code + '/' + (folder ? folder + '/' : '') + name;

function emptyMap(code) {
  return { id: mapId(code), ownerId: DOC_PK, type: 'project_map', code, defaultFile: null, geotech: null, placements: {}, updatedAt: '' };
}

// Every boring location plan page that has been tied in, one entry per report
// page. Older records held a single `plan`; it becomes the first entry.
const MAX_PLANS = 20;
function plansOf(doc) {
  const list = Array.isArray(doc.plans) ? doc.plans : (doc.plan ? [doc.plan] : []);
  return list.filter((p) => p && p.name).map((p) => Object.assign({}, p, { id: p.id || 'p' + (p.page || 0) }));
}

// What the browser gets: no file ids or batch ids, borings with their final spot.
function publicMap(doc) {
  const g = doc.geotech;
  const out = { code: doc.code, defaultFile: doc.defaultFile || null, geotech: null, plans: plansOf(doc), updatedAt: doc.updatedAt || '' };
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
      if (p) { o.lat = p.lat; o.lon = p.lon; o.placed = p.auto ? 'auto' : 'manual'; o.placedBy = p.by || ''; }
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

    // One page of the report, so the admin's browser can turn the boring location plan into an image.
    if (method === 'GET' && req.query && req.query.planPage) {
      if (!isAdmin(me)) return json(context, 403, { error: 'Only an admin can set up the boring location plan.' });
      const page = Math.round(Number(req.query.planPage));
      const cur = await readMap(records, code);
      const file = cur && cur.geotech && cur.geotech.file;
      if (!file) return json(context, 404, { error: 'No geotech report has been read for this job.' });
      const bc = (await getJobBooksContainer()).getBlockBlobClient(blobPath(code, file.folder, file.name));
      if (!(await bc.exists())) return json(context, 404, { error: 'The report file is no longer in the job book.' });
      let pdf = null;
      try {
        pdf = await geo.openPdf(await bc.downloadToBuffer(), 25000);
        if (!(page >= 1 && page <= pdf.pages)) return json(context, 400, { error: 'The report has ' + pdf.pages + ' pages — pick a page between 1 and ' + pdf.pages + '.' });
        const bytes = await pdf.extract(page, page, 12000);
        context.res = { status: 200, isRaw: true, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, max-age=300' }, body: bytes };
        return;
      } catch (e) {
        context.log.warn('job-map plan page: ' + (e.message || e));
        return json(context, 500, { error: 'Could not open that page: ' + String((e && e.message) || e).slice(0, 200) });
      } finally { if (pdf) pdf.close(); }
    }

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
        d.plans = plansOf(d).filter((p) => !p.report || p.report === name);   // plans pinned from a different report go
        delete d.plan;
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
    } else if (mode === 'setPlan') {
      const name = safeFileName(body.name || ''), folder = safeFileName(body.folder || '');
      if (!/\.(jpe?g|png)$/i.test(name)) return json(context, 400, { error: 'The plan has to be a JPG or PNG image.' });
      const w = Math.round(Number(body.w)), h = Math.round(Number(body.h)), page = Math.round(Number(body.page)) || 0;
      const pts = (Array.isArray(body.pts) ? body.pts : []).slice(0, 2).map((p) => ({ x: Number(p && p.x), y: Number(p && p.y), lat: Number(p && p.lat), lon: Number(p && p.lon) }));
      const good = (p) => [p.x, p.y, p.lat, p.lon].every(isFinite) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && p.x >= -w && p.x <= 2 * w && p.y >= -h && p.y <= 2 * h;
      if (!(w >= 50 && w <= 12000 && h >= 50 && h <= 12000) || pts.length !== 2 || !pts.every(good)) return json(context, 400, { error: 'Bad plan alignment.' });
      // Two reference points on top of each other pin nothing down.
      if (Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) < 20 || (Math.abs(pts[0].lat - pts[1].lat) < 1e-6 && Math.abs(pts[0].lon - pts[1].lon) < 1e-6)) {
        return json(context, 400, { error: 'The two reference points are too close together — pick two that are far apart.' });
      }
      const container = await getJobBooksContainer();
      if (!(await container.getBlockBlobClient(blobPath(code, folder, name)).exists())) return json(context, 404, { error: 'The plan image is not in the job book.' });
      const labels = (Array.isArray(body.labels) ? body.labels : []).slice(0, 300)
        .map((l) => ({ id: String((l && l.id) || '').slice(0, 40), x: Math.round(Number(l && l.x)), y: Math.round(Number(l && l.y)) }))
        .filter((l) => l.id && isFinite(l.x) && isFinite(l.y));
      // One saved plan per report page: saving a page again replaces that page's tie-in, every other page stays.
      r = await updateMap(records, code, (d) => {
        const id = 'p' + page;
        const list = plansOf(d).filter((p) => p.id !== id);
        if (list.length >= MAX_PLANS) return { error: 'This job already has ' + MAX_PLANS + ' saved plan pages — remove one first.', status: 409 };
        list.push({ id, folder, name, page, w, h, pts, labels, report: (d.geotech && d.geotech.file && d.geotech.file.name) || '', by: me.name || me.email, at: now });
        list.sort((a, b) => (a.page || 0) - (b.page || 0));
        d.plans = list; delete d.plan;
      });
    } else if (mode === 'clearPlan') {
      // Takes ONE saved page off the map — never all of them by accident.
      const id = String(body.id || '').slice(0, 20);
      if (!id) return json(context, 400, { error: 'Say which plan page to remove.' });
      r = await updateMap(records, code, (d) => {
        const list = plansOf(d);
        if (!list.some((p) => p.id === id)) return { error: 'That plan page is not saved on this job.', status: 404 };
        d.plans = list.filter((p) => p.id !== id); delete d.plan;
      });
    } else if (mode === 'planLocate') {
      // Pictures in, pixel positions out. Nothing is saved here — the browser turns positions it trusts into placements.
      const okImg = (i) => i && typeof i.data === 'string' && i.data.length > 200 && i.data.length < 2.2 * 1024 * 1024 && i.w >= 50 && i.w <= 2000 && i.h >= 50 && i.h <= 2000;
      const clean = (i) => ({ data: i.data.replace(/^data:image\/jpeg;base64,/, ''), w: Math.round(i.w), h: Math.round(i.h) });
      let content;
      if (body.stage === 'coarse') {
        const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => String(x).slice(0, 40)).filter(Boolean).slice(0, 80);
        if (!okImg(body.image) || !ids.length) return json(context, 400, { error: 'Bad request.' });
        content = planLocate.coarseContent(clean(body.image), ids);
      } else if (body.stage === 'refine') {
        const crops = (Array.isArray(body.crops) ? body.crops : []).slice(0, 8);
        if (!crops.length || !crops.every((c) => okImg(c) && c.id)) return json(context, 400, { error: 'Bad request.' });
        content = planLocate.refineContent(crops.map((c) => Object.assign(clean(c), { id: String(c.id).slice(0, 40) })));
      } else return json(context, 400, { error: 'Unknown stage.' });
      try {
        const out = await planLocate.locate(content, Date.now() + 38000);
        return json(context, 200, { ok: true, results: out.results });
      } catch (e) {
        context.log.warn('job-map planLocate: ' + (e.message || e));
        return json(context, 502, { error: String((e && e.message) || e).slice(0, 300) });
      }
    } else if (mode === 'placeBorings') {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200)
        .map((i) => ({ id: String((i && i.id) || '').slice(0, 40), lat: Number(i && i.lat), lon: Number(i && i.lon) }))
        .filter((i) => i.id && isFinite(i.lat) && isFinite(i.lon) && Math.abs(i.lat) <= 90 && Math.abs(i.lon) <= 180);
      if (!items.length) return json(context, 400, { error: 'Nothing to place.' });
      const auto = !!body.auto;
      r = await updateMap(records, code, (d) => {
        const known = new Set(((d.geotech && Array.isArray(d.geotech.borings)) ? d.geotech.borings : []).map((b) => b.id));
        d.placements = d.placements || {};
        items.forEach((i) => {
          if (!known.has(i.id)) return;
          const p = { lat: Math.round(i.lat * 1e7) / 1e7, lon: Math.round(i.lon * 1e7) / 1e7, by: auto ? 'the boring location plan' : (me.name || me.email), at: now };
          if (auto) p.auto = true;
          d.placements[i.id] = p;
        });
      });
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
