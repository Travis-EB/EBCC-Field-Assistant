// /api/projects — shared Job Books project list (visible to every signed-in user).
//
// GET    -> { projects: [{ code, name, createdAt, createdBy, links }] } (seeds on first use)
// POST   -> { code, name } creates a project (any signed-in user)
// POST   -> { mode:'addLink', code, name, url } adds a Procore/Autodesk-style
//           link to a project (any signed-in user); mode:'removeLink' is admin only
// DELETE -> ?code= removes a project (admin only; files in blob are left in place)
//
// Stored as ONE doc in the records container under ownerId '__shared__', so it
// never collides with per-user record queries. Writes use etag-checked replace
// with retries (same pattern as the ticket-number counter).
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { getJobBooksContainer, safeName } = require('../shared/blob');

const DOC_ID = 'projects';
const DOC_PK = '__shared__';

// Starter job books provided by Travis (2026-08)
const SEED = [
  ['26-292-03', 'PROSPER RETAIL'],
  ['26-120-03', 'PEPSI CO. TENANT IMPROVEMENTS'],
  ['26-100-03', 'NL35 III PH 1 - SITE & BUILDING 7'],
  ['26-086-03', 'ACN 6 - SHELL'],
  ['26-028-03', 'STREAM HYDE RANCH - PUBLIC'],
  ['26-027-03', 'STREAM HYDE RANCH - PRIVATE'],
  ['26-013-03', 'CORE 5 PLEASANT RUN'],
  ['25-324-03', 'CONSTELLATION ROCK ISLAND'],
  ['25-316-03', 'DFW NORTHWEST DISTRIBUTION aka CORINTH SPEC'],
  ['25-267-03', 'MEDLINE at CROSSROADS 5'],
  ['25-253-03', 'PRESTON CROSSROADS'],
  ['25-251-03', 'NORTHLAKE 35 LOGISTICS PARK III'],
  ['26-179-02', 'HIGHGROVE 1B'],
  ['26-079-02', 'THE HUB @ ONT, BUILDING 9 FINE GRADE'],
  ['26-078-02', 'THE HUB @ ONT, BUILDING 8 FINE GRADE'],
  ['26-077-02', 'THE HUB @ ONT, BUILDING 7 FINE GRADE'],
  ['26-076-02', 'THE HUB @ ONT, BUILDING 6 FINE GRADE'],
  ['26-075-02', 'THE HUB @ ONT, BUILDING 5 FINE GRADE'],
  ['26-059-02', 'JENSEN INFRASTRUCTURE'],
  ['26-050-02', 'THE HUB @ ONT - PHASE 2 POTHOLING'],
  ['26-007-02', 'EASTVALE SQUARE PHASE C'],
  ['25-309-02', 'EASTVALE SQUARE PHASE 2'],
  ['25-079-02', 'FOX FIELD WEST BUILDING 1'],
  ['25-033-02', 'DISTRICT 6 NORTH'],
  ['24-926-00', 'WEST CREEK'],
  ['24-279-02', 'AMAZON HESPERIA CAZ5'],
];

// Apply `fn(project)` to one project with an etag-checked replace, retrying
// when another writer got in first. Returns the project, or null if absent.
async function updateProject(records, code, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await readDoc(records);
    if (!doc) return null;
    const p = (doc.data || []).find((x) => x && String(x.code).toLowerCase() === String(code).toLowerCase());
    if (!p) return null;
    fn(p);
    try {
      await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
      return p;
    } catch (e) {
      if (e.code !== 412) throw e; // 412 = raced another writer — retry
    }
  }
  throw new Error('projects doc contention');
}

async function readDoc(records) {
  try {
    const { resource } = await records.item(DOC_ID, DOC_PK).read();
    return resource || null;
  } catch (e) {
    if (e.code !== 404) throw e;
    return null;
  }
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('projects ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const { records } = await getContainers();
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      let doc = await readDoc(records);
      if (!doc) {
        doc = {
          id: DOC_ID, ownerId: DOC_PK, type: 'projects',
          data: SEED.map(([code, name]) => ({
            code, name, createdAt: new Date().toISOString(), createdBy: 'seed',
          })),
        };
        try { await records.items.create(doc); } catch (e) { if (e.code !== 409) throw e; doc = await readDoc(records); }
      }
      // Per-book file totals (one container listing, grouped by project prefix)
      const sizes = {};
      try {
        const container = await getJobBooksContainer();
        for await (const blob of container.listBlobsFlat()) {
          const seg = blob.name.split('/')[0];
          if (!sizes[seg]) sizes[seg] = { n: 0, b: 0, t: 0 };
          sizes[seg].n++;
          sizes[seg].b += blob.properties.contentLength || 0;
          // newest upload — feeds the "Most recent" sort in Job Books
          const t = blob.properties.lastModified ? +new Date(blob.properties.lastModified) : 0;
          if (t > sizes[seg].t) sizes[seg].t = t;
        }
      } catch (e) { /* blob not configured — totals stay zero */ }
      const list = (doc.data || []).map((p) => {
        const s = sizes[safeName(p.code)] || { n: 0, b: 0, t: 0 };
        return Object.assign({}, p, { fileCount: s.n, totalSize: s.b, lastFileAt: s.t ? new Date(s.t).toISOString() : '' });
      }).sort((a, b) => String(b.code).localeCompare(String(a.code), undefined, { numeric: true }));
      return json(context, 200, { projects: list });
    }

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }

      // ---- project links (Procore / Autodesk / etc.) ----
      const mode = String((body && body.mode) || '');

      // ---- state (CA/TX) — picks the calculator rate library for the job ----
      if (mode === 'setState') {
        const code = String((body && body.code) || '').trim();
        const state = String((body && body.state) || '').toUpperCase();
        if (!code) return json(context, 400, { error: 'code required.' });
        if (state !== 'CA' && state !== 'TX') return json(context, 400, { error: 'State must be CA or TX.' });
        const p = await updateProject(records, code, (x) => { x.state = state; x.stateSetBy = me.email; x.stateSetAt = new Date().toISOString(); });
        if (!p) return json(context, 404, { error: 'Project not found.' });
        return json(context, 200, { ok: true, state });
      }

      // ---- foreman — one of the Field Assistant accounts ----
      if (mode === 'setForeman') {
        const code = String((body && body.code) || '').trim();
        if (!code) return json(context, 400, { error: 'code required.' });
        const email = String((body && body.email) || '').trim().toLowerCase();
        const name = String((body && body.name) || '').trim().slice(0, 80);
        if (email && !/^[^ @]+@[^ @]+[.][^ @]+$/.test(email)) return json(context, 400, { error: 'Bad email.' });
        const p = await updateProject(records, code, (x) => {
          if (!email) { delete x.foreman; }
          else { x.foreman = { email, name: name || email, setBy: me.email, setAt: new Date().toISOString() }; }
        });
        if (!p) return json(context, 404, { error: 'Project not found.' });
        return json(context, 200, { ok: true, foreman: p.foreman || null });
      }

      // ---- active flag (Active Jobs tab) — admin promotes / demotes ----
      if (mode === 'setActive') {
        if (!isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
        const code = String((body && body.code) || '').trim();
        if (!code) return json(context, 400, { error: 'code required.' });
        const active = !!(body && body.active);
        const p = await updateProject(records, code, (x) => {
          if (active) { x.active = true; x.activeSetBy = me.email; x.activeSetAt = new Date().toISOString(); }
          else { delete x.active; delete x.activeSetBy; delete x.activeSetAt; }
        });
        if (!p) return json(context, 404, { error: 'Project not found.' });
        return json(context, 200, { ok: true, active });
      }

      // ---- on-site schedule: machines + personnel with date ranges ----
      if (mode === 'setSchedule') {
        const code = String((body && body.code) || '').trim();
        if (!code) return json(context, 400, { error: 'code required.' });
        const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
        const raw = Array.isArray(body && body.schedule) ? body.schedule.slice(0, 300) : [];
        const schedule = [];
        for (const it of raw) {
          if (!it || typeof it !== 'object') continue;
          const start = String(it.start || '');
          const end = String(it.end || '');
          if (!DATE_RE.test(start)) continue;
          if (end && (!DATE_RE.test(end) || end < start)) continue;
          schedule.push({
            id: String(it.id || '').slice(0, 40) || Math.random().toString(36).slice(2, 10),
            kind: it.kind === 'person' ? 'person' : 'machine',
            name: String(it.name || '').trim().slice(0, 80),
            start, end,
            note: String(it.note || '').trim().slice(0, 200),
          });
        }
        if (schedule.some((x) => !x.name)) return json(context, 400, { error: 'Every entry needs a name.' });
        const p = await updateProject(records, code, (x) => { x.schedule = schedule; x.scheduleSetBy = me.email; x.scheduleSetAt = new Date().toISOString(); });
        if (!p) return json(context, 404, { error: 'Project not found.' });
        return json(context, 200, { ok: true, schedule });
      }

      // ---- per-project fuel price (drives CA equipment rate escalation) ----
      if (mode === 'setFuel') {
        const code = String((body && body.code) || '').trim();
        if (!code) return json(context, 400, { error: 'code required.' });
        const raw = body && body.fuelRate;
        const clearing = raw === '' || raw == null;
        const f = Math.round(parseFloat(raw) * 100) / 100;
        if (!clearing && !(isFinite(f) && f > 0 && f < 100)) {
          return json(context, 400, { error: 'Enter a fuel price like 4.25 (or leave empty to clear).' });
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const doc = await readDoc(records);
          if (!doc) return json(context, 404, { error: 'No projects.' });
          const p = (doc.data || []).find((x) => x && String(x.code).toLowerCase() === code.toLowerCase());
          if (!p) return json(context, 404, { error: 'Project not found.' });
          if (clearing) {
            delete p.fuelRate; delete p.fuelSetBy; delete p.fuelSetAt;
          } else {
            p.fuelRate = f;
            p.fuelSetBy = me.email;
            p.fuelSetAt = new Date().toISOString();
          }
          try {
            await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
            return json(context, 200, { ok: true, fuelRate: clearing ? null : f });
          } catch (e) {
            if (e.code === 412) continue; // raced another writer — retry
            throw e;
          }
        }
        return json(context, 500, { error: 'Busy — try again.' });
      }
      if (mode === 'addLink' || mode === 'removeLink') {
        if (mode === 'removeLink' && !isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
        const code = String((body && body.code) || '').trim();
        let url = String((body && body.url) || '').trim().slice(0, 500);
        const name = String((body && body.name) || '').trim().slice(0, 80);
        if (!code || !url) return json(context, 400, { error: 'code and url required.' });
        if (mode === 'addLink') {
          if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
          try { new URL(url); } catch (_) { return json(context, 400, { error: 'That is not a valid link.' }); }
        }
        for (let attempt = 0; attempt < 5; attempt++) {
          const doc = await readDoc(records);
          if (!doc) return json(context, 404, { error: 'No projects.' });
          const p = (doc.data || []).find((x) => x && String(x.code).toLowerCase() === code.toLowerCase());
          if (!p) return json(context, 404, { error: 'Project not found.' });
          p.links = Array.isArray(p.links) ? p.links : [];
          if (mode === 'addLink') {
            if (p.links.some((l) => l && l.url === url)) return json(context, 409, { error: 'That link is already on this project.' });
            if (p.links.length >= 20) return json(context, 400, { error: 'Link limit reached (20 per project).' });
            let label = name;
            if (!label) { try { label = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { label = url; } }
            p.links.push({ name: label, url, addedBy: me.email, addedAt: new Date().toISOString() });
          } else {
            p.links = p.links.filter((l) => !(l && l.url === url));
          }
          try {
            await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
            return json(context, 200, { ok: true, links: p.links });
          } catch (e) {
            if (e.code === 412) continue; // raced another writer — retry
            throw e;
          }
        }
        return json(context, 500, { error: 'Busy — try again.' });
      }

      const code = String((body && body.code) || '').trim().slice(0, 40);
      const name = String((body && body.name) || '').trim().slice(0, 120);
      if (!code || !name) return json(context, 400, { error: 'Both project code and name are required.' });
      for (let attempt = 0; attempt < 5; attempt++) {
        let doc = await readDoc(records);
        if (!doc) {
          doc = { id: DOC_ID, ownerId: DOC_PK, type: 'projects', data: [] };
          try { await records.items.create(doc); } catch (e) { if (e.code !== 409) throw e; continue; }
          doc = await readDoc(records);
        }
        if ((doc.data || []).some((p) => p && p.code.toLowerCase() === code.toLowerCase())) {
          return json(context, 409, { error: 'A project with that code already exists.' });
        }
        doc.data = doc.data || [];
        doc.data.push({ code, name, createdAt: new Date().toISOString(), createdBy: me.email });
        try {
          await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
          return json(context, 200, { ok: true, project: { code, name } });
        } catch (e) {
          if (e.code === 412) continue; // raced another writer — retry
          throw e;
        }
      }
      return json(context, 500, { error: 'Busy — try again.' });
    }

    if (method === 'DELETE') {
      if (!isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
      const code = String((req.query && req.query.code) || '').trim();
      if (!code) return json(context, 400, { error: 'code required.' });
      for (let attempt = 0; attempt < 5; attempt++) {
        const doc = await readDoc(records);
        if (!doc) return json(context, 404, { error: 'No projects.' });
        doc.data = (doc.data || []).filter((p) => !(p && p.code === code));
        try {
          await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
          return json(context, 200, { ok: true });
        } catch (e) {
          if (e.code === 412) continue;
          throw e;
        }
      }
      return json(context, 500, { error: 'Busy — try again.' });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('projects', e);
    return json(context, 500, { error: 'Server error.' });
  }
};
