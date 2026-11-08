'use strict';
// Return destinations come from server-owned tenant configuration, never launch
// request bodies, Referer, Origin, or URL fragments supplied by the player.
async function storefrontURL(db, tenant, publicOrigin) {
  const primary = (await db.query('SELECT domain FROM agency_domains WHERE tenant_id=$1 AND verified_at IS NOT NULL AND is_primary', [tenant.id])).rows[0];
  if (primary) return 'https://' + primary.domain;
  if (tenant.slug === '64cor') return 'https://playground-agent-frontend-production.up.railway.app';
  const origin = new URL(publicOrigin);
  if (origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol)) throw Error('Invalid public origin');
  return origin.origin + '/site/' + encodeURIComponent(tenant.slug);
}
async function gameNavigation(db, tenant, publicOrigin) {
  return {home_url: await storefrontURL(db, tenant, publicOrigin), label: tenant.name};
}
module.exports = {storefrontURL, gameNavigation};
