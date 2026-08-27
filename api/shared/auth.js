// Shared identity + data helpers for the EBCC Field Assistant API.
//
// SECURITY MODEL
// --------------
// Identity is taken ONLY from the `x-ms-client-principal` header that Azure
// Static Web Apps injects after a successful Entra sign-in. The browser cannot
// forge this header — SWA strips any client-supplied copy and re-adds its own.
// We therefore never trust a user id, email, or role sent in the request body.
//
// Authorization (admin vs user) comes from OUR `users` container, not from the
// token, so Travis can manage roles at runtime. Seed admins via the
// ADMIN_EMAILS app setting (defaults to travis@earthbasics.net).

const { CosmosClient } = require('@azure/cosmos');

const DB_NAME = 'ebcc';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'travis@earthbasics.net')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let _clients = null;

async function getContainers() {
  if (_clients) return _clients;
  const conn = process.env.COSMOS_CONN;
  if (!conn) throw new Error('COSMOS_CONN app setting is not configured.');
  const client = new CosmosClient(conn);
  const { database } = await client.databases.createIfNotExists({ id: DB_NAME });
  const { container: users } = await database.containers.createIfNotExists({
    id: 'users',
    partitionKey: { paths: ['/id'] },
  });
  const { container: records } = await database.containers.createIfNotExists({
    id: 'records',
    partitionKey: { paths: ['/ownerId'] },
  });
  _clients = { users, records };
  return _clients;
}

// Decode the SWA client principal. Returns null if unauthenticated.
function getPrincipal(req) {
  const header =
    (req.headers && (req.headers['x-ms-client-principal'] || req.headers['X-MS-CLIENT-PRINCIPAL'])) || null;
  if (!header) return null;
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    const p = JSON.parse(json);
    if (!p || !p.userId) return null;
    return {
      userId: p.userId, // stable, unique per user per app
      email: (p.userDetails || '').toLowerCase(),
      identityProvider: p.identityProvider || '',
      raw: p,
    };
  } catch (e) {
    return null;
  }
}

// Look up (or create on first sight) the user record, and stamp last-active.
// Returns the persisted user doc including its role.
// Display-name priority: a name the user typed themselves ('user') is never
// overwritten; an Entra name claim ('claims') beats the company contact list
// ('contacts'); the bare email is the last resort. Most callers pass the email
// as displayName — that must never clobber a real name (it used to, which is
// why accounts showed emails as names).
function realName(displayName, email) {
  const n = String(displayName || '').trim();
  if (!n || n.toLowerCase() === String(email || '').trim().toLowerCase()) return '';
  return n;
}
function contactName(email) {
  try {
    const { NAME_BY_EMAIL } = require('./contacts');
    return NAME_BY_EMAIL[String(email || '').trim().toLowerCase()] || '';
  } catch (e) { return ''; }
}

async function ensureUser(principal, displayName) {
  const { users } = await getContainers();
  const id = principal.userId;
  let doc = null;
  try {
    const { resource } = await users.item(id, id).read();
    doc = resource || null;
  } catch (e) {
    if (e.code !== 404) throw e;
  }

  const now = new Date().toISOString();
  const seededAdmin = ADMIN_EMAILS.includes(principal.email);
  const claimName = realName(displayName, principal.email);
  const listName = contactName(principal.email);

  if (!doc) {
    doc = {
      id,
      email: principal.email,
      name: claimName || listName || principal.email || 'Unknown',
      nameSource: claimName ? 'claims' : (listName ? 'contacts' : 'email'),
      role: seededAdmin ? 'admin' : 'user',
      createdAt: now,
      lastActiveAt: now,
      counts: {},
    };
  } else {
    doc.lastActiveAt = now;
    if (principal.email) doc.email = principal.email;
    if (doc.nameSource !== 'user') {
      if (claimName) { doc.name = claimName; doc.nameSource = 'claims'; }
      else if (!realName(doc.name, doc.email) && listName) { doc.name = listName; doc.nameSource = 'contacts'; }
    }
    // Seeded admins are always at least admin (never silently demoted below admin).
    if (seededAdmin && doc.role !== 'admin') doc.role = 'admin';
  }
  const { resource } = await users.items.upsert(doc);
  return resource;
}

function isAdmin(userDoc) {
  return !!userDoc && userDoc.role === 'admin';
}

function json(context, status, body) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

module.exports = { getContainers, getPrincipal, ensureUser, isAdmin, json, ADMIN_EMAILS };
