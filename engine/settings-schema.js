'use strict';
const { RequestError } = require('./transaction');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (max, min = 0) => v => typeof v === 'string' && v.length <= max && v.trim().length >= min && !v.includes('\0');
const bool = v => typeof v === 'boolean';
const number = (max, min = 0, integer = true) => v => typeof v === 'number' && Number.isFinite(v) && (!integer || Number.isSafeInteger(v)) && v >= min && v <= max;
const choice = values => v => values.includes(v);
const color = v => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v);
function timezone(v) {
  if (!text(80, 1)(v)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: v }).format(); return true; } catch { return false; }
}
function safeUrl(v) {
  if (!text(2048)(v)) return false;
  if (v === '') return true;
  if (/^\/(?!\/)[a-z0-9/_?.=&%#-]*$/i.test(v)) return true;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
const schemas = {
  general: { site_title: text(160, 1), currency: text(32, 1), currency_symbol: text(16, 1), timezone,
    base_color: color, secondary_color: color, per_page: choice([20, 50, 100]), currency_format: choice(['symbol', 'text', 'both']),
    register_bonus: number(1e9), demo_balance: number(1e9), transfer_fixed: number(1e9), transfer_percent: number(100, 0, false),
    gameplay_bonus_count: number(1e6), gameplay_bonus: number(1e9) },
  logo: { logo_url: safeUrl, favicon_url: safeUrl },
  configuration: { name: text(160, 1), read_only: bool, bridge_enabled: bool },
  notification: { in_app_enabled: bool, email_enabled: bool, sender: text(160, 1) },
  seo: { meta_title: text(160), meta_description: text(1000), keywords: text(1000) },
  kyc: { kyc_enabled: bool, retention_days: number(3650, 1) },
  social: { google: bool, apple: bool },
  language: { default_locale: choice(['en', 'id']), supported: v => text(100, 1)(v) && v.split(',').every(x => ['en', 'id'].includes(x.trim())) && new Set(v.split(',').map(x=>x.trim())).size === v.split(',').length },
  extensions: { registry_url: safeUrl, enabled: bool },
  cron: { enabled: bool, interval_minutes: choice([5, 10, 15, 30, 60]), description: text(500) },
  maintenance: { enabled: bool, message: text(2000) },
  gdpr: { notice: text(8000), required: bool },
  css: { draft: text(12000) },
  sitemap: { enabled: bool, endpoint: choice(['/sitemap.xml']) },
  robots: { rules: text(4000) }
};
const contentModules = Object.freeze({ templates: 'template', pages: 'page', frontend: 'frontend', policies: 'policy' });
function errorsFor(key, value) {
  if (Object.hasOwn(contentModules, key)) return ['Use the versioned content editor for this module'];
  if (!Object.hasOwn(schemas, key)) return ['Unknown settings module'];
  if (!plain(value) || !Object.keys(value).length || JSON.stringify(value).length > 16000) return ['A nonempty settings object is required'];
  const schema = schemas[key], errors = [];
  for (const [name, v] of Object.entries(value)) {
    if (!Object.hasOwn(schema, name)) errors.push('Unknown field: ' + name);
    else if (!schema[name](v)) errors.push('Invalid value for ' + name);
  }
  if (key === 'language' && typeof value.supported === 'string' && value.default_locale && !value.supported.split(',').map(x=>x.trim()).includes(value.default_locale)) errors.push('Default locale must be in supported locales');
  return errors;
}
function validate(key, value) {
  const errors = errorsFor(key, value);
  if (errors.length) throw new RequestError(400, errors.join('; '), 'SETTINGS_VALIDATION');
  return value;
}
function expectedVersion(v) {
  if (v === undefined) throw new RequestError(428, 'Reload this settings form before saving (expected_version is required)', 'VERSION_REQUIRED');
  if (!Number.isSafeInteger(v) || v < 0 || v > 2147483646) throw new RequestError(400, 'Invalid expected_version', 'INVALID_VERSION');
  return v;
}
module.exports = { validate, errorsFor, expectedVersion, schemas, contentModules };
