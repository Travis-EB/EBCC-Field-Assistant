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
    return json(context, 500, { authenticated: true, error: 'Server error resolving user.' });
  }
};
