// Reading a geotechnical report for the job map.
//
// A soils report can run to hundreds of pages, far more than one model call
// (or one 45-second function call) can take. So the report is cut into page
// ranges with pdf-lib, each range is uploaded to the Files API, and all of
// them go to Claude as ONE Message Batch — it runs in the background and the
// map polls for the result. Each range returns the exploration logs found on
// its pages; mergeResults() stitches them back into one list of borings.
//
// Claude calls here are raw fetch, like the rest of this API (no SDK
// dependency). Batches cannot use server-side fallbacks, so a refusal or an
// error on a page range is reported as a warning instead of retried elsewhere.
const path = require('path');
const { Worker } = require('worker_threads');

const API = 'https://api.anthropic.com/v1';
const VERSION = '2026-10-21';
const MODEL = process.env.GEOTECH_MODEL || 'claude-opus-5-5';
const CHUNK_PAGES = 30;
const MAX_PAGES = 900;
const MAX_TOKENS = 64000;

const SYSTEM = [
  'You read geotechnical (soils) reports for an earthwork contractor. Foremen and project managers use what you extract to see what is in the ground at each boring before they dig, so accuracy matters more than completeness.',
  '',
  'You are given a range of pages from one report as a PDF. Find every exploration log on these pages: soil borings, test pits, hand augers, CPT soundings. Transcribe what each log records.',
  '',
  'Rules:',
  '- Copy values exactly as printed. Leave a text field empty ("") when the log does not show it. Never estimate, infer or fill in a value.',
  '- id: the exploration number as printed (B-1, TP-3, HA-2).',
  '- page: the page within the pages you were given where that log starts. The first page you were given is 1.',
  '- Depths are in feet as plain numbers. If the log is in meters, convert to feet and say so in notes. Use -1 for a depth that is not shown.',
  '- strata: one entry per soil or rock layer, top to bottom, with the description as written (color, soil type, moisture, consistency) and the USCS symbol if the log gives one.',
  '- samples: one entry per sample or field/lab test row on the log, with the depth it applies to. Put blow counts / N-value in blows exactly as printed (for example "5-7-9" or "N=16" or "50/4\\""). Put anything the log records that has no field of its own in other.',
  '- groundwater: what the log records about water (depth encountered, depth after a wait, "dry", "not encountered"), as written.',
  '- Coordinates: fill lat and lon ONLY when the report prints numeric coordinates for that exploration, on the log itself or in a table of locations. Use decimal degrees, west longitude negative. Use 0 for both when none are printed. Do not read coordinates off a map or plan drawing. Copy state-plane northing and easting as text when given.',
  '- locations: if these pages include a table or list of exploration coordinates, list every row there, even for explorations whose logs are on other pages.',
  '- planPages: pages (numbered the same way) that show a boring or exploration location plan.',
  '- report: the report title, the geotechnical firm, the report date and the project name, when these pages show them. Otherwise "".',
  '- A log that continues from before these pages or runs past them: transcribe the part you can see, under the same id.',
  '- Most page ranges in a report contain no logs (narrative, lab plots, calculations). Return empty lists for those.',
].join('\n');

const S = { type: 'string' };
const N = { type: 'number' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  report: obj({ title: S, firm: S, reportDate: S, projectName: S }),
  borings: {
    type: 'array',
    items: obj({
      id: S,
      kind: { type: 'string', enum: ['boring', 'test pit', 'hand auger', 'cpt', 'other'] },
      page: { type: 'integer' },
      dateDrilled: S,
      surfaceElevation: S,
      totalDepthFt: N,
      lat: N,
      lon: N,
      northing: S,
      easting: S,
      locationNote: S,
      groundwater: S,
      strata: { type: 'array', items: obj({ topFt: N, bottomFt: N, description: S, uscs: S }) },
      samples: {
        type: 'array',
        items: obj({ depthFt: N, type: S, blows: S, moisturePct: S, dryDensityPcf: S, liquidLimit: S, plasticityIndex: S, passing200Pct: S, pocketPenTsf: S, other: S }),
      },
      notes: S,
    }),
  },
  locations: { type: 'array', items: obj({ id: S, lat: N, lon: N, northing: S, easting: S }) },
  planPages: { type: 'array', items: { type: 'integer' } },
});

const JSON_ONLY = '\n\nReply with ONE JSON object and nothing else (no prose, no code fence), exactly matching this JSON Schema:\n' + JSON.stringify(SCHEMA);

function apiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY app setting is not configured.');
  return k;
}
function headers(json) {
  const h = { 'x-api-key': apiKey(), 'anthropic-version': VERSION };
  if (json) h['content-type'] = 'application/json';
  return h;
}
// The API's own words for what went wrong, so the office can act on it.
async function apiError(r) {
  let detail = '';
  try { const j = JSON.parse(await r.text()); detail = (j && j.error && j.error.message) || ''; } catch (e) {}
  const err = new Error('Claude API ' + r.status + (detail ? ': ' + detail : ''));
  err.status = r.status;
  return err;
}

// ---- splitting ----
function splitPlan(pageCount) {
  const out = [];
  for (let from = 1; from <= pageCount; from += CHUNK_PAGES) out.push({ from, to: Math.min(pageCount, from + CHUNK_PAGES - 1) });
  return out;
}

// Open a report in a worker thread (see pdfWorker.js for why). Resolves to
// { pages, extract(from, to) -> Buffer, close() }. Rejects with code
// PDF_PASSWORD (needs a password), PDF_TIMEOUT (too slow to open) or the
// parser's own error for a file it cannot make sense of.
function openPdf(buffer, timeoutMs) {
  const worker = new Worker(path.join(__dirname, 'pdfWorker.js'));
  worker.unref();
  let seq = 0, dead = false;
  const pending = new Map();
  const failAll = (err) => { pending.forEach((p) => { clearTimeout(p.timer); p.rej(err); }); pending.clear(); };
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) { const err = new Error(m.error); err.code = m.code || ''; p.rej(err); } else p.res(m);
  });
  worker.on('error', (e) => { dead = true; failAll(e); });
  worker.on('exit', () => { dead = true; failAll(new Error('The PDF reader stopped unexpectedly.')); });
  const close = () => { dead = true; worker.terminate().catch(() => {}); };
  const ask = (msg, ms, transfer) => new Promise((res, rej) => {
    if (dead) { rej(new Error('The PDF reader is no longer running.')); return; }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id); close();
      const err = new Error('The PDF took too long to open (over ' + Math.round(ms / 1000) + ' seconds).'); err.code = 'PDF_TIMEOUT'; rej(err);
    }, ms);
    pending.set(id, { res, rej, timer });
    worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
  // the worker gets its own copy; the caller keeps the original bytes
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return ask({ op: 'load', buffer: copy }, timeoutMs || 22000, [copy]).then(
    (r) => ({ pages: r.pages, extract: (from, to, ms) => ask({ op: 'extract', from, to }, ms || 15000).then((x) => Buffer.from(x.bytes)), close }),
    (e) => { close(); throw e; }
  );
}

// ---- Files API ----
async function uploadPdf(bytes, filename, timeoutMs) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: 'application/pdf' }), filename);
  const r = await fetch(API + '/files', { method: 'POST', headers: headers(false), body: fd, signal: AbortSignal.timeout(timeoutMs || 30000) });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  if (!j || !j.id) throw new Error('File upload returned no id.');
  return j.id;
}
async function deleteFile(id) {
  try { await fetch(API + '/files/' + encodeURIComponent(id), { method: 'DELETE', headers: headers(false), signal: AbortSignal.timeout(8000) }); } catch (e) {}
}

// ---- batch ----
// shape 0: schema-constrained output. shape 1: plain JSON-by-instruction, used
// once as a second try if the API rejects the first request shape.
function buildParams(chunk, total, reportName, shape) {
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: shape === 0 ? SYSTEM : SYSTEM + JSON_ONLY,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'file', file_id: chunk.fileId } },
        { type: 'text', text: chunk.whole
          ? 'This is the whole report "' + reportName + '". Number pages from 1.'
          : 'These are pages ' + chunk.from + ' to ' + chunk.to + ' of ' + total + ' of the report "' + reportName + '". Number pages from 1 within this range.' },
      ],
    }],
  };
  if (shape === 0) params.output_config = { format: { type: 'json_schema', schema: SCHEMA } };
  return params;
}
async function createBatch(chunks, total, reportName, shape) {
  const requests = chunks.map((c, i) => ({ custom_id: 'c' + i, params: buildParams(c, total, reportName, shape) }));
  const r = await fetch(API + '/messages/batches', { method: 'POST', headers: headers(true), body: JSON.stringify({ requests }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw await apiError(r);
  const j = await r.json();
  if (!j || !j.id) throw new Error('Batch create returned no id.');
  return j.id;
}
async function getBatch(id) {
  const r = await fetch(API + '/messages/batches/' + encodeURIComponent(id), { headers: headers(false), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw await apiError(r);
  return r.json();
}
async function getResults(batch) {
  const url = batch.results_url || (API + '/messages/batches/' + encodeURIComponent(batch.id) + '/results');
  const r = await fetch(url, { headers: headers(false), signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw await apiError(r);
  const text = await r.text();
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// One batch line -> { index, data } | { index, error, invalid }
function readResult(line) {
  const index = Number(String(line.custom_id || '').replace(/^c/, ''));
  const res = line.result || {};
  if (res.type !== 'succeeded') {
    const e = (res.error && (res.error.error || res.error)) || {};
    return { index, error: res.type === 'errored' ? (e.message || e.type || 'request failed') : (res.type || 'no result'), invalid: e.type === 'invalid_request_error' };
  }
  const msg = res.message || {};
  if (msg.stop_reason === 'refusal') return { index, error: 'the model declined to read these pages' };
  const text = (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let data = null;
  try { data = JSON.parse(text); } catch (e) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { data = JSON.parse(text.slice(a, b + 1)); } catch (e2) {} }
  }
  if (!data || typeof data !== 'object') {
    return { index, error: msg.stop_reason === 'max_tokens' ? 'too much on these pages to read in one pass' : 'the reply could not be read' };
  }
  return { index, data };
}

// ---- merge ----
const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => { const x = Number(v); return isFinite(x) ? x : null; };
const depth = (v) => { const x = num(v); return x == null || x < 0 || x > 2000 ? null : Math.round(x * 100) / 100; };
function coord(lat, lon) {
  const a = num(lat), b = num(lon);
  if (a == null || b == null || (a === 0 && b === 0)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: Math.round(a * 1e7) / 1e7, lon: Math.round(b * 1e7) / 1e7 };
}
// "b 01", "B-1", "B1" are the same boring.
function normId(id) {
  const s = str(id, 40).toUpperCase();
  const m = s.match(/^([A-Z]{1,6})[\s._-]*0*(\d{1,4})([A-Z]?)$/);
  return m ? m[1] + '-' + m[2] + m[3] : s;
}
const longer = (a, b) => (String(b || '').length > String(a || '').length ? b : a);

function mergeResults(chunks, results) {
  const byId = new Map();
  const warnings = [];
  const report = { title: '', firm: '', reportDate: '', projectName: '' };
  const planPages = new Set();
  const locs = new Map();
  results.slice().sort((a, b) => a.index - b.index).forEach((r) => {
    const c = chunks[r.index];
    if (!c) return;
    const label = c.whole ? 'the report' : 'pages ' + c.from + '–' + c.to;
    if (r.error) { warnings.push(label + ': ' + r.error); return; }
    const d = r.data;
    const abs = (p) => { const x = Math.round(Number(p)); return isFinite(x) && x >= 1 ? (c.whole ? x : Math.min(c.to, c.from + x - 1)) : c.from; };
    if (d.report && typeof d.report === 'object') Object.keys(report).forEach((k) => { if (!report[k]) report[k] = str(d.report[k], 160); });
    (Array.isArray(d.planPages) ? d.planPages : []).forEach((p) => planPages.add(abs(p)));
    (Array.isArray(d.locations) ? d.locations : []).forEach((l) => {
      const id = normId(l && l.id); if (!id) return;
      const cur = locs.get(id) || { northing: '', easting: '' };
      const ll = coord(l.lat, l.lon);
      if (ll && !cur.ll) cur.ll = ll;
      cur.northing = cur.northing || str(l.northing, 30); cur.easting = cur.easting || str(l.easting, 30);
      locs.set(id, cur);
    });
    (Array.isArray(d.borings) ? d.borings : []).forEach((b) => {
      const id = normId(b && b.id); if (!id) return;
      let cur = byId.get(id);
      if (!cur) {
        cur = { id, kind: 'boring', page: abs(b.page), dateDrilled: '', surfaceElevation: '', totalDepthFt: null, northing: '', easting: '', locationNote: '', groundwater: '', notes: '', strata: new Map(), samples: new Map(), ll: null };
        byId.set(id, cur);
      }
      cur.page = Math.min(cur.page, abs(b.page));
      if (['boring', 'test pit', 'hand auger', 'cpt', 'other'].includes(b.kind) && cur.kind === 'boring') cur.kind = b.kind;
      cur.dateDrilled = cur.dateDrilled || str(b.dateDrilled, 40);
      cur.surfaceElevation = cur.surfaceElevation || str(b.surfaceElevation, 40);
      const td = depth(b.totalDepthFt); if (td != null && (cur.totalDepthFt == null || td > cur.totalDepthFt)) cur.totalDepthFt = td;
      cur.northing = cur.northing || str(b.northing, 30); cur.easting = cur.easting || str(b.easting, 30);
      cur.locationNote = longer(cur.locationNote, str(b.locationNote, 200));
      cur.groundwater = longer(cur.groundwater, str(b.groundwater, 300));
      cur.notes = longer(cur.notes, str(b.notes, 600));
      cur.ll = cur.ll || coord(b.lat, b.lon);
      // The same layer or sample seen twice (a log split across page ranges,
      // or a report bound into the PDF twice) collapses onto one key.
      (Array.isArray(b.strata) ? b.strata : []).forEach((s) => {
        const top = depth(s && s.topFt); if (top == null) return;
        const bottom = depth(s.bottomFt);
        const key = top + '|' + (bottom == null ? '' : bottom);
        const old = cur.strata.get(key);
        const row = { topFt: top, bottomFt: bottom, description: str(s.description, 400), uscs: str(s.uscs, 12) };
        if (!old || row.description.length > old.description.length) cur.strata.set(key, row);
      });
      (Array.isArray(b.samples) ? b.samples : []).forEach((s) => {
        const dft = depth(s && s.depthFt); if (dft == null) return;
        const row = { depthFt: dft, type: str(s.type, 30), blows: str(s.blows, 40), moisturePct: str(s.moisturePct, 16), dryDensityPcf: str(s.dryDensityPcf, 16),
          liquidLimit: str(s.liquidLimit, 12), plasticityIndex: str(s.plasticityIndex, 12), passing200Pct: str(s.passing200Pct, 12), pocketPenTsf: str(s.pocketPenTsf, 16), other: str(s.other, 160) };
        const key = dft + '|' + row.type.toLowerCase();
        const old = cur.samples.get(key);
        if (!old || JSON.stringify(row).length > JSON.stringify(old).length) cur.samples.set(key, row);
      });
    });
  });
  const borings = [...byId.values()].map((b) => {
    const l = locs.get(b.id);
    const ll = b.ll || (l && l.ll) || null;
    const strata = [...b.strata.values()].sort((x, y) => x.topFt - y.topFt).slice(0, 40);
    const samples = [...b.samples.values()].sort((x, y) => x.depthFt - y.depthFt).slice(0, 80);
    return {
      id: b.id, kind: b.kind, page: b.page, dateDrilled: b.dateDrilled, surfaceElevation: b.surfaceElevation, totalDepthFt: b.totalDepthFt,
      lat: ll ? ll.lat : null, lon: ll ? ll.lon : null,
      northing: b.northing || (l ? l.northing : ''), easting: b.easting || (l ? l.easting : ''),
      locationNote: b.locationNote, groundwater: b.groundwater, notes: b.notes, strata, samples,
    };
  }).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).slice(0, 200);
  return { report, borings, warnings, planPages: [...planPages].sort((a, b) => a - b).slice(0, 20) };
}

module.exports = {
  MODEL, CHUNK_PAGES, MAX_PAGES, SCHEMA, SYSTEM,
  splitPlan, openPdf, uploadPdf, deleteFile, buildParams, createBatch, getBatch, getResults, readResult, mergeResults, normId,
};
