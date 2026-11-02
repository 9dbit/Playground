'use strict';
const publicKinds = ['page', 'policy'];
const slug = value => typeof value === 'string' && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
function contentPath(kind, contentSlug) { return publicKinds.includes(kind) ? '/info/' + kind + '/' + contentSlug : null; }
function attachContentLink(row) { return { ...row, public_path: contentPath(row.kind, row.slug) }; }
function mount(app, { pool, publicOrigin = 'https://playground-admin-production.up.railway.app' }) {
  const origin = new URL(publicOrigin).origin;
  async function maintenance(res) {
    const q = await pool.query("SELECT value FROM gameops_settings WHERE key='maintenance'");
    if (q.rows[0]?.value?.enabled !== true) return false;
    res.status(503).set('Retry-After', '300').type('text/plain').send('Maintenance in progress');
    return true;
  }
  app.get('/robots.txt', wrap(async (req, res) => {
    const q = await pool.query("SELECT value FROM gameops_settings WHERE key='robots'");
    const rules = q.rows[0]?.value?.rules;
    res.type('text/plain').send(typeof rules === 'string' && rules.length <= 4000 ? rules : 'User-agent: *\nDisallow: /engine\nDisallow: /api/\nDisallow: /login\n');
  }));
  app.get('/sitemap.xml', wrap(async (req, res) => {
    const setting = await pool.query("SELECT value FROM gameops_settings WHERE key='sitemap'");
    const q = setting.rows[0]?.value?.enabled === false ? { rows: [] } :
      await pool.query("SELECT kind,slug,updated_at FROM gameops_content WHERE status='published' AND kind IN ('page','policy') ORDER BY kind,slug LIMIT 1000");
    const entries = q.rows.map(row => '<url><loc>' + escape(origin + contentPath(row.kind, row.slug)) + '</loc></url>').join('\n');
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries + '\n</urlset>');
  }));
  app.get('/info/:kind/:contentSlug', wrap(async (req, res) => {
    if (!publicKinds.includes(req.params.kind) || !slug(req.params.contentSlug)) return res.status(404).send('Not found');
    if (await maintenance(res)) return;
    const q = await pool.query("SELECT title,body FROM gameops_content WHERE kind=$1 AND slug=$2 AND status='published'", [req.params.kind, req.params.contentSlug]);
    if (!q.rowCount) return res.status(404).send('Not found');
    const canonical = origin + contentPath(req.params.kind, req.params.contentSlug);
    res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="canonical" href="' + escape(canonical) + '"><title>' + escape(q.rows[0].title) + '</title></head><body><main style="font:16px system-ui;max-width:760px;margin:8vh auto;padding:25px;white-space:pre-wrap"><h1>' + escape(q.rows[0].title) + '</h1>' + escape(q.rows[0].body) + '</main></body></html>');
  }));
  app.get('/info/:contentSlug', wrap(async (req, res) => {
    if (!slug(req.params.contentSlug)) return res.status(404).send('Not found');
    if (await maintenance(res)) return;
    const q = await pool.query("SELECT kind,slug,title FROM gameops_content WHERE slug=$1 AND status='published' AND kind IN ('page','policy') ORDER BY kind", [req.params.contentSlug]);
    if (!q.rowCount) return res.status(404).send('Not found');
    if (q.rowCount === 1) return res.redirect(308, contentPath(q.rows[0].kind, q.rows[0].slug));
    // Keep both existing documents. Never choose an arbitrary LIMIT 1 winner.
    res.status(300).set('X-Robots-Tag', 'noindex').type('html').send('<!doctype html><meta charset="utf-8"><title>Choose a document</title><h1>More than one document uses this old address</h1>' + q.rows.map(row => '<p><a href="' + contentPath(row.kind, row.slug) + '">' + escape(row.kind + ': ' + row.title) + '</a></p>').join(''));
  }));
}
module.exports = { mount, contentPath, attachContentLink };
