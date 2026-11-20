// POST /api/incident-update — add one entry to a submitted incident report's
// follow-up log. The original report is never touched: this only appends
// { id, ts, by, byEmail, text } to report.updates, stamped with the server's
// clock and the signed-in user. There is no edit and no delete — /api/records
// also refuses to change or drop entries (see mergeIncidentReports there).
//
// Who: the report's author, or an admin (pass ownerId for someone else's).
// Body:  { reportId, text, ownerId? }
// Reply: { ok:true, update, updates } | { ok:false, error }
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');

const MAX_TEXT = 2000;
const MAX_ENTRIES = 60;

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('incident-update ensureUser', e);
    return json(context, 500, { ok: false, error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { ok: false, error: 'Account disabled.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return json(context, 400, { ok: false, error: 'Bad request.' });

  const reportId = String(body.reportId || '').slice(0, 60);
  const text = String(body.text == null ? '' : body.text).replace(/\r\n?/g, '\n').trim().slice(0, MAX_TEXT);
  if (!reportId) return json(context, 400, { ok: false, error: 'Missing report.' });
  if (!text) return json(context, 400, { ok: false, error: 'Write the update first.' });

  let ownerId = me.id;
  const wantOwner = String(body.ownerId || '').slice(0, 120);
  if (wantOwner && wantOwner !== me.id) {
    if (!isAdmin(me)) return json(context, 403, { ok: false, error: 'Only the person who filed the report or an admin can add to its log.' });
    ownerId = wantOwner;
  }

  try {
    const { records } = await getContainers();
    const docId = ownerId + ':incident_reports';
    for (let attempt = 0; attempt < 5; attempt++) {
      let doc = null;
      try { doc = (await records.item(docId, ownerId).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
      const r = doc && Array.isArray(doc.data) ? doc.data.find((x) => x && x.id === reportId) : null;
      if (!r) return json(context, 404, { ok: false, code: 'not-synced', error: 'That report is not on the account yet — give it a moment to sync and try again.' });
      const list = Array.isArray(r.updates) ? r.updates.filter((u) => u && u.id && u.text) : [];
      if (list.length >= MAX_ENTRIES) return json(context, 409, { ok: false, error: 'This log is full (' + MAX_ENTRIES + ' entries).' });
      const now = new Date().toISOString();
      const update = {
        id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        ts: now,
        by: String(me.name || me.email || '').slice(0, 80),
        byEmail: String(me.email || '').slice(0, 120),
        text,
      };
      list.push(update);
      r.updates = list;
      // Later than whatever a phone with a fast clock stamped, so every device adopts it.
      r.updatedAt = String(r.updatedAt || '') >= now ? new Date(Date.parse(r.updatedAt) + 1000).toISOString() : now;
      doc.updatedAt = now;
      try {
        await records.item(docId, ownerId).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
      } catch (e) {
        if (e.code === 412) continue; // raced a sync or another entry — re-read and retry
        throw e;
      }
      return json(context, 200, { ok: true, update, updates: list, updatedAt: r.updatedAt });
    }
    return json(context, 409, { ok: false, error: 'The report was busy — try again.' });
  } catch (e) {
    context.log.error('incident-update', e);
    if (e && (e.code === 413 || /too large/i.test(e.message || ''))) return json(context, 400, { ok: false, error: 'The account record is full — tell the office.' });
    return json(context, 500, { ok: false, error: 'Server error.' });
  }
};
