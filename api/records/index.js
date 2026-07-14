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
  'trucking_tickets', 'load_count', 'ewt_records',
  // Calculator tabs — synced so admins can review what's being priced out
  'cpy_state', 'flat_state', 'lime_state', 'flexbase_state',
]);

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

      return json(context, 200, { ok: true, updatedAt: now });
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
    return json(context, 500, { error: 'Server error.' });
  }
};
