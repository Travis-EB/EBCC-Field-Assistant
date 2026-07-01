// /api/users — ADMIN ONLY. List users and change roles/status.
// GET   -> list all users (id, email, name, role, lastActiveAt, counts).
// PATCH -> { userId, role } where role in { admin, user, disabled }.
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');

const VALID_ROLES = new Set(['admin', 'user', 'disabled']);

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('users ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (!isAdmin(me)) return json(context, 403, { error: 'Admin only.' });

  const { users } = await getContainers();
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (method === 'GET') {
      const { resources } = await users.items
        .query('SELECT c.id, c.email, c.name, c.role, c.createdAt, c.lastActiveAt, c.counts FROM c')
        .fetchAll();
      resources.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
      return json(context, 200, { users: resources });
    }

    if (method === 'PATCH') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body || !body.userId || !VALID_ROLES.has(body.role)) {
        return json(context, 400, { error: 'Body must be { userId, role } with a valid role.' });
      }
      if (body.userId === me.id && body.role !== 'admin') {
        return json(context, 400, { error: 'You cannot remove your own admin access.' });
      }
      let target;
      try {
        const { resource } = await users.item(body.userId, body.userId).read();
        target = resource;
      } catch (e) { if (e.code === 404) return json(context, 404, { error: 'User not found.' }); throw e; }
      target.role = body.role;
      const { resource } = await users.items.upsert(target);
      return json(context, 200, { ok: true, user: { id: resource.id, role: resource.role } });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('users error', e);
    return json(context, 500, { error: 'Server error.' });
  }
};
