'use strict';
const { HttpError, withTransaction, writeAudit } = require('./database-unit');
const text = (max, min = 0) => ({ type: 'text', min, max });
const integer = (min, max) => ({ type: 'integer', min, max });
const bool = { type: 'boolean' };
const url = { type: 'url', max: 2048 };
const choices = values => ({ type: 'enum', values });
const schemas = Object.freeze({
  general: {
    site_title: text(100, 1), currency: text(24, 1), currency_symbol: text(12, 1),
    timezone: { type: 'timezone' }, base_color: { type: 'color' }, secondary_color: { type: 'color' },
    per_page: choices([20, 50, 100]), currency_format: choices(['symbol', 'text', 'both']),
    register_bonus: integer(0, 1000000000), demo_balance: integer(0, 1000000000),
    transfer_fixed: integer(0, 1000000000), transfer_percent: { type: 'number', min: 0, max: 100 },
    gameplay_bonus_count: integer(0, 1000000000), gameplay_bonus: integer(0, 1000000000)
  },
  logo: { logo_url: url, favicon_url: url },
  configuration: { name: text(100, 1), read_only: bool, bridge_enabled: bool },
  notification: { in_app_enabled: bool, email_enabled: bool, sender: text(100, 1) },
  seo: { meta_title: text(180), meta_description: text(1000), keywords: text(500) },
  kyc: { kyc_enabled: bool, retention_days: integer(1, 3650) },
  social: { google: bool, apple: bool },
  language: { default_locale: choices(['en', 'id']), supported: { type: 'locales' } },
  extensions: { registry_url: url, enabled: bool },
  cron: { enabled: bool, interval_minutes: choices([5, 10, 15, 30, 60]), description: text(500) },
  maintenance: { enabled: bool, message: text(2000) },
  gdpr: { notice: text(4000), required: bool },
  css: { draft: text(12000) },
  sitemap: { enabled: bool, endpoint: choices(['/sitemap.xml']) },
  robots: { rules: text(4000) }
});
const contentModules = ['templates', 'pages', 'frontend', 'policies'];
function isRecord(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function validateField(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean' ? null : 'Must be boolean';
  if (rule.type === 'enum') return rule.values.includes(value) ? null : 'Select one of the allowed values with the correct type';
  if (rule.type === 'integer' || rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (rule.type === 'integer' && !Number.isSafeInteger(value)) || value < rule.min || value > rule.max) {
      return 'Must be ' + (rule.type === 'integer' ? 'an integer' : 'a number') + ' from ' + rule.min + ' to ' + rule.max;
    }
    return null;
  }
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return 'Must be text without control characters';
  if (rule.type === 'text') return value.length <= rule.max && value.trim().length >= rule.min ? null : 'Text length is outside the allowed range';
  if (rule.type === 'color') return /^#[0-9a-f]{6}$/i.test(value) ? null : 'Use a six-digit hex color, e.g. #4939f5';
  if (rule.type === 'timezone') {
    if (value.length > 80 || !value.trim() || value !== value.trim()) return 'Use a valid IANA timezone';
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return null; } catch { return 'Use a valid IANA timezone'; }
  }
  if (rule.type === 'locales') {
    const locales = value.split(',').map(x => x.trim());
    return value.length <= 20 && locales.length >= 1 && locales.length <= 2 &&
      locales.every(x => ['en', 'id'].includes(x)) && new Set(locales).size === locales.length ? null : 'Supported locales must be en, id, or en,id';
  }
  if (rule.type === 'url') {
    if (value === '') return null;
    if (value.length > rule.max || /[\s\\]/.test(value)) return 'Use a relative site path or HTTPS URL';
    if (/^\/(?!\/)/.test(value)) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) return null;
    } catch { /* invalid URL */ }
    return 'Use a relative site path or HTTPS URL without credentials';
  }
  return 'Unsupported field';
}
function validateSetting(key, value) {
  if (!Object.hasOwn(schemas, key)) {
    return { valid: false, errors: [{ field: 'module', message: contentModules.includes(key) ? 'Manage this module through versioned CMS content, not generic settings' : 'Unknown settings module' }] };
  }
  if (!isRecord(value) || !Object.keys(value).length || Buffer.byteLength(JSON.stringify(value)) > 16000) {
    return { valid: false, errors: [{ field: 'value', message: 'Provide a nonempty settings object under 16 KB' }] };
  }
  const errors = [], schema = schemas[key];
  for (const [name, v] of Object.entries(value)) {
    if (!Object.hasOwn(schema, name)) { errors.push({ field: name, message: 'Unknown field for this module' }); continue; }
    const message = validateField(schema[name], v);
    if (message) errors.push({ field: name, message });
  }
  if (key === 'language' && typeof value.supported === 'string' && value.default_locale &&
      !value.supported.split(',').map(x => x.trim()).includes(value.default_locale)) {
    errors.push({ field: 'supported', message: 'Supported locales must include the default locale' });
  }
  return { valid: errors.length === 0, errors };
}
async function ensureSchema(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS gameops_settings_versions(key text NOT NULL REFERENCES gameops_settings(key) ON DELETE RESTRICT,version integer NOT NULL,value jsonb NOT NULL,actor text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(key,version))');
}
async function saveSettings(pool, key, body, actor) {
  if (!isRecord(body) || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version > 2147483646) {
    throw new HttpError(428, 'Reload settings and provide expected_version (0 for a new record)', 'VERSION_REQUIRED');
  }
  if (Object.keys(body).some(k => !['value', 'expected_version'].includes(k))) {
    throw new HttpError(400, 'Unexpected settings request fields', 'INVALID_SETTINGS');
  }
  const checked = validateSetting(key, body.value);
  if (!checked.valid) throw new HttpError(400, 'Settings validation failed', 'INVALID_SETTINGS', { fields: checked.errors });
  return withTransaction(pool, async db => {
    const previous = await db.query('SELECT key,value,version,updated_by FROM gameops_settings WHERE key=$1 FOR UPDATE', [key]);
    if ((previous.rowCount && previous.rows[0].version !== body.expected_version) || (!previous.rowCount && body.expected_version !== 0)) {
      throw new HttpError(409, 'Settings changed in another tab. Reload before saving; your unsaved values have been kept.', 'VERSION_CONFLICT');
    }
    if (previous.rowCount) {
      const old = previous.rows[0];
      await db.query('INSERT INTO gameops_settings_versions(key,version,value,actor) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [key,old.version,JSON.stringify(old.value),old.updated_by]);
    }
    let result;
    if (body.expected_version === 0) {
      result = await db.query('INSERT INTO gameops_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING RETURNING key,version,updated_at',
        [key, JSON.stringify(body.value), actor]);
    } else {
      result = await db.query('UPDATE gameops_settings SET value=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE key=$1 AND version=$4 RETURNING key,version,updated_at',
        [key, JSON.stringify(body.value), actor, body.expected_version]);
    }
    if (!result.rowCount) throw new HttpError(409, 'Settings changed in another tab. Reload before saving; your unsaved values have been kept.', 'VERSION_CONFLICT');
    await db.query('INSERT INTO gameops_settings_versions(key,version,value,actor) VALUES($1,$2,$3,$4)', [key,result.rows[0].version,JSON.stringify(body.value),actor]);
    await writeAudit(db, actor, 'settings.saved', key, { version: result.rows[0].version });
    return { item: result.rows[0] };
  });
}
module.exports = { schemas, contentModules, validateSetting, saveSettings, ensureSchema };
