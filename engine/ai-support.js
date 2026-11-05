'use strict';

// Public embed identifiers only. Never expose credentials, identity or page data.
const ORIGIN = 'https://chatvice.app';
const WIDGET_URL = ORIGIN + '/widget/m_36f76fcbe11167ed?embedded=true&showClose=true';
const PAGES = new Set(['/engine', '/integrations', '/data', '/wallet']);
const BASE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function contentSecurityPolicy(pathname) {
  return BASE_CSP + '; frame-src ' + (PAGES.has(pathname) ? ORIGIN : "'none'");
}

// Mount only after security.adminAuth, which checks the session, MFA and role.
function configHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  if (process.env.PLAYGROUND_AI_SUPPORT_ENABLED === '0') return res.json({ enabled: false });
  const expiresAt = new Date(req.auth.expires_at).getTime();
  const validUntil = Math.min(expiresAt, Date.now() + 30 * 60 * 1000);
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) {
    return res.status(401).json({ error: 'Login required' });
  }
  return res.json({ enabled: true, url: WIDGET_URL, validUntil });
}

module.exports = { ORIGIN, WIDGET_URL, contentSecurityPolicy, configHandler };
