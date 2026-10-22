// /api/project-records — safety records filed against ONE job, across every
// user: JHAs, tailgate talks (toolbox_records) and incident reports. Those
// records live per user (`<userId>:<type>` docs); this is the only place that
// reads across users, so it queries by project code and returns a trimmed
// view (no signature images, no inline PDFs) plus short-lived read links for
// the archived PDFs / photos in the private ewt-pdfs store.
//
// GET ?code= -> { jha:[…], talks:[…], incidents:[…], generatedAt }
// Any signed-in, non-disabled user (company safety records are shared).
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');
const { getEwtContainer } = require('../shared/blob');
const { BlobSASPermissions } = require('@azure/storage-blob');
const { readDoc, findProject } = require('../shared/projects');

const TYPES = ['jha_records', 'incident_reports', 'toolbox_records'];
const MAX_PER_TYPE = 50;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 200);
const yesKeys = (o) => Object.keys(o && typeof o === 'object' ? o : {}).filter((k) => o[k] === true);

// Items for this job from every user's safety docs. Preferred: let Cosmos do
// the per-item filter with an ARRAY subquery. Fallback (if the subquery form
// is rejected): pull the docs and filter in Node.
async function fetchItems(records, code, log) {
  const lc = String(code).toLowerCase();
  const typeList = TYPES.map((t) => "'" + t + "'").join(',');
  try {
    const q = {
      query: 'SELECT c.ownerId, c.ownerEmail, c.type, ARRAY(SELECT VALUE r FROM r IN c.data WHERE LOWER(r.projectCode) = @code) AS items ' +
             'FROM c WHERE c.type IN (' + typeList + ') AND EXISTS(SELECT VALUE r FROM r IN c.data WHERE LOWER(r.projectCode) = @code)',
      parameters: [{ name: '@code', value: lc }],
    };
    const { resources } = await records.items.query(q).fetchAll();
    return resources.map((d) => ({ ownerId: d.ownerId, ownerEmail: d.ownerEmail, type: d.type, items: Array.isArray(d.items) ? d.items : [] }));
  } catch (e) {
    log.warn('project-records subquery failed, falling back: ' + (e.message || e));
    const q = { query: 'SELECT c.ownerId, c.ownerEmail, c.type, c.data FROM c WHERE c.type IN (' + typeList + ')' };
    const { resources } = await records.items.query(q).fetchAll();
    return resources.map((d) => ({
      ownerId: d.ownerId, ownerEmail: d.ownerEmail, type: d.type,
      items: (Array.isArray(d.data) ? d.data : []).filter((r) => r && String(r.projectCode || '').toLowerCase() === lc),
    }));
  }
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });
  let me;
  try { me = await ensureUser(principal, principal.email); }
  catch (e) { context.log.error('project-records ensureUser', e); return json(context, 500, { error: 'Server error.' }); }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const code = String((req.query && req.query.code) || '').trim();
  if (!code) return json(context, 400, { error: 'code required.' });

  try {
    const { users, records } = await getContainers();
    const p = findProject(await readDoc(records), code);
    if (!p) return json(context, 404, { error: 'Project not found.' });

    // Display names for the people who filed the records
    const names = {};
    try {
      const { resources } = await users.items.query('SELECT c.id, c.name, c.email FROM c').fetchAll();
      resources.forEach((u) => { names[u.id] = u.name || u.email; });
    } catch (e) { context.log.warn('project-records names: ' + (e.message || e)); }

    // Read links into the private store (15 minutes), or null when blob isn't configured
    let container = null;
    try { container = await getEwtContainer(); } catch (e) { context.log.warn('project-records blob: ' + (e.message || e)); }
    const link = async (path) => {
      if (!container || !path) return null;
      try {
        return await container.getBlockBlobClient(String(path)).generateSasUrl({
          permissions: BlobSASPermissions.parse('r'),
          expiresOn: new Date(Date.now() + 15 * 60 * 1000),
        });
      } catch (e) { return null; }
    };

    const docs = await fetchItems(records, p.code, context.log);
    const out = { jha: [], talks: [], incidents: [], generatedAt: new Date().toISOString() };
    for (const d of docs) {
      const owner = d.ownerId, ownerName = names[owner] || d.ownerEmail || owner;
      for (const r of d.items) {
        if (!r) continue;
        const base = { id: str(r.id, 60), owner, ownerName, date: str(r.date, 10), sent: !!r.sent, sentTs: str(r.sentTs, 30), emailedTo: Array.isArray(r.emailedTo) ? r.emailedTo.slice(0, 10) : [], pdfUrl: await link(r.pdfBlob) };
        const sos = Array.isArray(r.signoffs) ? r.signoffs : [];
        if (d.type === 'jha_records') {
          out.jha.push(Object.assign(base, {
            preparedBy: str(r.preparedBy, 80), contractor: str(r.contractor, 80), description: str(r.description, 400),
            hazards: yesKeys(r.hazards), steps: (Array.isArray(r.steps) ? r.steps : []).filter((s) => s && (s.step || s.hazard || s.control)).length,
            total: sos.length, signedCount: sos.filter((s) => s && s.sig).length, injuredCount: sos.filter((s) => s && s.injured === 'yes').length,
          }));
        } else if (d.type === 'toolbox_records') {
          out.talks.push(Object.assign(base, {
            leader: str(r.leader, 80), topics: yesKeys(r.topics).concat(r.other ? [str(r.other, 120)] : []), comments: str(r.comments, 300),
            attendees: sos.length, signedCount: sos.filter((s) => s && s.sig).length,
          }));
        } else {
          const blobs = Array.isArray(r.photoBlobs) ? r.photoBlobs : [];
          const photoUrls = [];
          for (const b of blobs.slice(0, 12)) { const u = await link(b && b.path); if (u) photoUrls.push(u); }
          const thumbs = Array.isArray(r.photos) ? r.photos : [];
          out.incidents.push(Object.assign(base, {
            time: str(r.time, 10), type: str(r.type, 40), reporter: str(r.reporter, 80), involved: str(r.involved, 200), location: str(r.location, 200),
            desc: str(r.desc, 500), injury: str(r.injury, 300), action: str(r.action, 300), witnesses: str(r.witnesses, 200),
            photoCount: Math.max(blobs.length, thumbs.length), photoUrls, thumb: thumbs[0] && thumbs[0].thumb ? String(thumbs[0].thumb).slice(0, 60000) : '',
          }));
        }
      }
    }
    const newest = (a, b) => String(b.date).localeCompare(String(a.date)) || String(b.sentTs).localeCompare(String(a.sentTs));
    ['jha', 'talks', 'incidents'].forEach((k) => { out[k].sort(newest); out[k] = out[k].slice(0, MAX_PER_TYPE); });
    return json(context, 200, out);
  } catch (e) {
    context.log.error('project-records', e);
    return json(context, 500, { error: 'Server error.' });
  }
};
