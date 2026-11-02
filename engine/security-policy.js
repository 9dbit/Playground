'use strict';
// Deny by default. Both original and deep APIs are covered; the UI is not an authorization boundary.
const rules = [
  ['GET', /^\/ops\/search\/?$/, ['owner','operator','support','viewer']],
  ['GET', /^\/ops\/notifications\/?$/, ['owner','operator','support','viewer']],
  ['POST', /^\/ops\/notifications\/(?:[1-9][0-9]{0,17}\/read|read-all)\/?$/, ['owner','operator','support','viewer']],
  ['GET', /^\/ops\/profile\/?$/, ['owner','operator','support','viewer']],
  ['PUT', /^\/ops\/profile\/?$/, ['owner','operator','support','viewer']],
  ['GET', /^\/ops\/cron\/?$/, ['owner','operator','support','viewer']],
  ['POST', /^\/ops\/cron\/run\/?$/, ['owner']],
  ['GET', /^\/parity\/?$/, ['owner','operator','support','viewer']],
  ['GET', /^\/virtual-wallets\/[0-9a-f-]{36}\/?$/, ['owner','operator','support']],
  ['POST', /^\/virtual-wallets\/[0-9a-f-]{36}\/(?:adjust|transfer)\/?$/, ['owner']],
  ['GET', /^\/virtual-ledger\/?$/, ['owner']],
  ['GET', /^\/bridge(?:\/[a-z0-9-]+\/rounds)?\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['GET', /^\/(?:summary|deep\/summary)\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['GET', /^\/(?:games(?:\/[^/]+)?|deep\/games(?:\/[^/]+(?:\/(?:image|rounds))?)?)\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['POST', /^\/(?:games|deep\/games\/[^/]+\/image)\/?$/, ['owner', 'operator']],
  ['PUT', /^\/deep\/games\/[^/]+\/?$/, ['owner', 'operator']],
  ['PATCH', /^\/games\/[^/]+\/?$/, ['owner', 'operator']],
  ['GET', /^\/(?:players|deep\/players(?:\/[^/]+(?:\/rounds)?)?)\/?$/, ['owner', 'operator', 'support']],
  ['PUT', /^\/deep\/players\/[^/]+\/?$/, ['owner', 'operator']],
  ['GET', /^\/(?:rounds|deep\/rounds(?:\/[^/]+)?)\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['GET', /^\/(?:requests|deep\/requests\/[^/]+)\/?$/, ['owner', 'operator']],
  ['PATCH', /^\/requests\/[^/]+\/?$/, ['owner']],
  ['GET', /^\/(?:tickets|deep\/tickets\/[^/]+)\/?$/, ['owner', 'operator', 'support']],
  ['POST', /^\/(?:tickets|deep\/tickets\/[^/]+\/replies)\/?$/, ['owner', 'support']],
  ['PATCH', /^\/tickets\/[^/]+\/?$/, ['owner', 'support']],
  ['GET', /^\/settings\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['PUT', /^\/settings\/[^/]+\/?$/, ['owner']],
  ['GET', /^\/audit\/?$/, ['owner']],
  ['GET', /^\/(?:system|deep\/system\/(?:server|application|cache|update|cron|security))\/?$/, ['owner', 'operator', 'support', 'viewer']],
  ['GET', /^\/deep\/reports\/transactions\/?$/, ['owner', 'operator', 'viewer']],
  ['GET', /^\/deep\/reports\/(?:logins|transfers)\/?$/, ['owner']],
  ['GET', /^\/deep\/reports\/notifications\/?$/, ['owner', 'support']],
  ['POST', /^\/deep\/notifications\/?$/, ['owner', 'support']],
  ['GET', /^\/deep\/subscribers\/?$/, ['owner', 'support']],
  ['POST', /^\/deep\/subscribers\/?$/, ['owner', 'support']],
  ['PATCH', /^\/deep\/subscribers\/[^/]+\/?$/, ['owner', 'support']],
  ['GET', /^\/deep\/content\/(?:page|policy|template|frontend)(?:\/[^/]+)?\/?$/, ['owner', 'operator']],
  ['POST', /^\/deep\/content\/(?:page|policy|template|frontend)\/?$/, ['owner', 'operator']],
  ['PUT', /^\/deep\/content\/(?:page|policy|template|frontend)\/[^/]+\/?$/, ['owner', 'operator']]
];
function canAccess(role, method, path) {
  method = method === 'HEAD' ? 'GET' : method;
  return rules.some(([m, pattern, roles]) => m === method && pattern.test(path) && roles.includes(role));
}
module.exports = { canAccess, roles: ['owner', 'operator', 'support', 'viewer'] };
