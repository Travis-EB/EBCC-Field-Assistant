// GET /api/me — returns the signed-in user's identity + role.
// Creates the user record on first sign-in and stamps last-active.
const { getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) {
    return json(context, 401, { authenticated: false });
  }

  // Prefer a friendly display name from the AAD claims if present.
  let displayName = principal.email;
  try {
    const claims = (principal.raw && principal.raw.claims) || [];
    const nameClaim = claims.find(
      (c) => c.typ === 'name' || c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
    );
    if (nameClaim && nameClaim.val) displayName = nameClaim.val;
  } catch (e) {}

  // The client reads the 'name' claim from /.auth/me (not always present in the
  // header principal) and passes it along. Cosmetic only — a user can only affect
  // their own display name; identity/role never come from the client.
  const qName = req.query && req.query.name;
  if (qName && typeof qName === 'string') {
    const clean = qName.replace(/[^\p{L}\p{M} .,'-]/gu, "").trim().slice(0, 80);
    if (clean) displayName = clean;
  }

  try {
    const user = await ensureUser(principal, displayName);
    if (user.role === 'disabled') {
      return json(context, 200, {
        authenticated: true,
        disabled: true,
        email: user.email,
        name: user.name,
      });
    }
    return json(context, 200, {
      authenticated: true,
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isAdmin: isAdmin(user),
    });
  } catch (e) {
    context.log.error('me error', e);
    // Surface the underlying cause (code + message) — this endpoint is auth-only,
    // and we need field-visible diagnostics while there's no App Insights.
    const detail = (e && (e.code || '') + ' ' + (e.message || String(e))).slice(0, 300);
    return json(context, 500, { authenticated: true, error: 'Server error resolving user.', detail: detail });
  }
};
