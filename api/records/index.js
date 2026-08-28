// /api/records — per-user field records (Truck Tickets, Load Count, Extra Work Tickets).
//
// Storage shape: one document per (user, type), holding that type's whole blob
// (mirrors the app's localStorage keys). id = `${ownerId}:${type}`.
//
// ISOLATION: a normal user can only read/write their OWN records. Only an admin
// may pass ?userId=<id> to read another user's records. Ownership is derived
// from the trusted client-principal, never from the request body.
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');

const ALLOWED_TYPES = new Set([
  'trucking_tickets', 'load_count', 'load_count_sends', 'ewt_records', 'ewt_drafts',
  'jha_records', 'production_sends',
  // Posted spreads (explicit snapshots for admin review)
  'cpy_posts', 'flat_posts', 'lime_posts', 'flexbase_posts',
  // Calculator tabs — synced so admins can review what's being priced out
  'cpy_state', 'flat_state', 'lime_state', 'flexbase_state',
]);

// EWT pushes must never destroy stored PDFs. The client's copy of ewt_records
// doesn't know the blob paths /api/send-ewt writes server-side, so a blind
// upsert used to wipe them — leaving only the newest ticket with an openable
// PDF. Merge by (ticketNo, date): keep the stored pdfBlob (or inline pdf) when
// the incoming record arrives without one, and keep tickets that exist only on
// the server (written by send-ewt or another device — the app has no EWT delete).
function mergeEwtRecords(prev, next) {
  const key = (r) => ((r && r.ticketNo) || '') + '|' + ((r && r.date) || '');
  const byKey = new Map();
  prev.forEach((r) => { if (r) byKey.set(key(r), r); });
  const out = next.filter(Boolean).map((r) => {
    const old = byKey.get(key(r));
    byKey.delete(key(r));
    if (!old) return r;
    if (!r.pdfBlob && old.pdfBlob) { r.pdfBlob = old.pdfBlob; if (r.pdf) r.pdf = ''; }
    else if (!r.pdfBlob && !r.pdf && old.pdf) { r.pdf = old.pdf; }
    return r;
  });
  byKey.forEach((r) => out.push(r));
  out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  // Size guard for the 2MB doc cap: blob-backed records don't need inline
  // copies; blob-less inline PDFs are kept newest-first within a byte budget.
  if (out.length > 100) out.splice(0, out.length - 100);
  let budget = 1500 * 1024, kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i];
    if (!r || !r.pdf) continue;
    if (r.pdfBlob) { r.pdf = ''; continue; }
    const len = r.pdf.length;
    if (kept >= 10 || len > 600 * 1024 || len > budget) { r.pdf = ''; }
    else { budget -= len; kept++; }
  }
  return out;
}

// EWT drafts are edited from more than one device (laptop to write, phone to
// collect the signature), so a blind upsert would let whichever device pushed
// last erase the other's drafts. Merge by draft id: newest savedAt wins, and
// a tombstone (deleted on any device) always beats a live copy so deletes
// stick everywhere. Tombstones age out after 30 days.
function mergeEwtDrafts(prev, next) {
  const byId = new Map();
  const consider = (d) => {
    if (!d || !d.id) return;
    const cur = byId.get(d.id);
    if (!cur) { byId.set(d.id, d); return; }
    if (d.tombstone && !cur.tombstone) { byId.set(d.id, d); return; }
    if (cur.tombstone && !d.tombstone) return;
    const a = String(d.savedAt || d.deletedAt || ''), b = String(cur.savedAt || cur.deletedAt || '');
    if (a > b) byId.set(d.id, d);
  };
  prev.forEach(consider);
  next.forEach(consider);
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const out = [];
  byId.forEach((d) => {
    if (d.tombstone) { const t = Date.parse(d.deletedAt || 0); if (isFinite(t) && t < cutoff) return; }
    out.push(d);
  });
  out.sort((a, b) => String(a.savedAt || a.deletedAt || '').localeCompare(String(b.savedAt || b.deletedAt || '')));
  return out;
}

// JHAs follow the drafts flow (created on a laptop, signed on a phone), so
// pushes merge by JHA id — newest updatedAt wins — and the merged list goes
// back to the client. Size guard for the 2MB doc cap: signature images are
// stripped from the oldest JHAs first; whole oldest records only as a last
// resort.
function mergeJhaRecords(prev, next) {
  const byId = new Map();
  const consider = (j) => {
    if (!j || !j.id) return;
    const cur = byId.get(j.id);
    if (!cur || String(j.updatedAt || '') > String(cur.updatedAt || '')) byId.set(j.id, j);
  };
  prev.forEach(consider);
  next.forEach(consider);
  const out = [...byId.values()];
  out.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (out.length > 150) out.splice(0, out.length - 150);
  let size = JSON.stringify(out).length;
  for (let i = 0; i < out.length && size > 1400 * 1024; i++) {
    (out[i].signoffs || []).forEach((s) => {
      if (s && s.sig) { size -= s.sig.length; s.sig = ''; s.sigTrimmed = true; }
    });
  }
  while (out.length > 1 && JSON.stringify(out).length > 1600 * 1024) out.shift();
  return out;
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('records ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const { records, users } = await getContainers();
  const method = (req.method || 'GET').toUpperCase();

  // Resolve which owner's data we're acting on.
  const requestedUserId = req.query && req.query.userId;
  let ownerId = me.id;
  if (requestedUserId && requestedUserId !== me.id) {
    if (!isAdmin(me)) return json(context, 403, { error: 'Forbidden.' });
    ownerId = requestedUserId; // admin viewing another user
  }

  try {
    if (method === 'GET') {
      const { resources } = await records.items
        .query({
          query: 'SELECT c.type, c.data, c.updatedAt FROM c WHERE c.ownerId = @o',
          parameters: [{ name: '@o', value: ownerId }],
        }, { partitionKey: ownerId })
        .fetchAll();
      const out = {};
      resources.forEach((r) => { out[r.type] = { data: r.data, updatedAt: r.updatedAt }; });
      return json(context, 200, { ownerId, records: out });
    }

    if (method === 'POST') {
      // Writing another user's data is not allowed even for admins (admins review, not edit).
      if (ownerId !== me.id) return json(context, 403, { error: 'Cannot write to another user.' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body || !ALLOWED_TYPES.has(body.type)) {
        return json(context, 400, { error: 'Body must be { type, data } with a valid type.' });
      }
      let merged = null; // returned to the client so it can adopt the merged view
      if ((body.type === 'ewt_records' || body.type === 'ewt_drafts' || body.type === 'jha_records') && Array.isArray(body.data)) {
        try {
          let existing = null;
          try { existing = (await records.item(me.id + ':' + body.type, me.id).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
          const prev = existing && Array.isArray(existing.data) ? existing.data : [];
          body.data = body.type === 'ewt_records' ? mergeEwtRecords(prev, body.data)
            : body.type === 'jha_records' ? mergeJhaRecords(prev, body.data)
            : mergeEwtDrafts(prev, body.data);
          if (body.type === 'ewt_drafts' || body.type === 'jha_records') merged = body.data;
        } catch (e) { context.log.warn(body.type + ' merge failed', e); }
      }
      const now = new Date().toISOString();
      const doc = {
        id: me.id + ':' + body.type,
        ownerId: me.id,
        ownerEmail: me.email,
        type: body.type,
        data: body.data,
        updatedAt: now,
      };
      await records.items.upsert(doc);

      // Light activity log: record counts + last active on the user doc.
      try {
        const count = Array.isArray(body.data)
          ? body.data.length
          : (body.data && typeof body.data === 'object' ? 1 : 0);
        me.counts = me.counts || {};
        me.counts[body.type] = count;
        me.lastActiveAt = now;
        await users.items.upsert(me);
      } catch (e) { context.log.warn('count update failed', e); }

      return json(context, 200, merged ? { ok: true, updatedAt: now, data: merged } : { ok: true, updatedAt: now });
    }

    if (method === 'DELETE') {
      if (ownerId !== me.id && !isAdmin(me)) return json(context, 403, { error: 'Forbidden.' });
      const type = req.query && req.query.type;
      if (!type || !ALLOWED_TYPES.has(type)) return json(context, 400, { error: 'Valid ?type= required.' });
      try {
        await records.item(ownerId + ':' + type, ownerId).delete();
      } catch (e) { if (e.code !== 404) throw e; }
      return json(context, 200, { ok: true });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('records error', e);
    if (e && (e.code === 413 || /too large/i.test(e.message || ''))) {
      return json(context, 400, { error: 'Record too large — reopen the app so it can auto-trim old PDFs.' });
    }
    return json(context, 500, { error: 'Server error.' });
  }
};
