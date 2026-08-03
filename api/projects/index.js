// /api/projects — shared Job Books project list (visible to every signed-in user).
//
// GET    -> { projects: [{ code, name, createdAt, createdBy }] } (seeds on first use)
// POST   -> { code, name } creates a project (any signed-in user)
// DELETE -> ?code= removes a project (admin only; files in blob are left in place)
//
// Stored as ONE doc in the records container under ownerId '__shared__', so it
// never collides with per-user record queries. Writes use etag-checked replace
// with retries (same pattern as the ticket-number counter).
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');

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
      const list = (doc.data || []).slice().sort((a, b) => String(b.code).localeCompare(String(a.code)));
      return json(context, 200, { projects: list });
    }

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
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
