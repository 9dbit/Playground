'use strict';
const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;
const publishedKinds = ['page','policy'];
const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
function publicPath(item) { return publishedKinds.includes(item.kind) && item.status === 'published' ? '/info/'+item.kind+'/'+item.slug : null; }
function publicOrigin() {
  const value = process.env.PUBLIC_SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://'+process.env.RAILWAY_PUBLIC_DOMAIN : 'https://playground-admin-production.up.railway.app');
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid public site origin');
  return url.origin;
}
async function maintenance(pool) {
  const q = await pool.query("SELECT value FROM gameops_settings WHERE key='maintenance'");
  return q.rows[0]?.value?.enabled === true;
}
async function inspectConflicts(pool) {
  const q = await pool.query("SELECT count(*)::int AS total FROM (SELECT slug FROM gameops_content WHERE kind IN ('page','policy') AND status='published' GROUP BY slug HAVING count(*)>1) s");
  return q.rows[0].total;
}
function mount(app, {pool}) {
  app.get('/sitemap.xml',wrap(async(req,res)=>{
    const flag = await pool.query("SELECT value FROM gameops_settings WHERE key='sitemap'");
    if (flag.rows[0]?.value?.enabled === false) return res.status(404).type('text/plain').send('Sitemap disabled');
    const q = await pool.query("SELECT kind,slug,status FROM gameops_content WHERE status='published' AND kind IN ('page','policy') ORDER BY kind,slug LIMIT 1000");
    const base = publicOrigin();
    const urls = [...new Set(q.rows.map(x=>base+publicPath(x)))];
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+urls.map(x=>'  <url><loc>'+html(x)+'</loc></url>').join('\n')+'\n</urlset>');
  }));
  app.get('/info/:kind/:contentSlug',wrap(async(req,res)=>{
    if (!publishedKinds.includes(req.params.kind) || !slug(req.params.contentSlug)) return res.status(404).send('Not found');
    if (await maintenance(pool)) return res.status(503).type('text/plain').send('Maintenance in progress');
    const q = await pool.query("SELECT kind,slug,title,body,status FROM gameops_content WHERE kind=$1 AND slug=$2 AND status='published'",[req.params.kind,req.params.contentSlug]);
    if (!q.rowCount) return res.status(404).send('Not found');
    const item=q.rows[0],canonical=publicOrigin()+publicPath(item);
    res.set('Link','<'+canonical+'>; rel="canonical"');
    res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="canonical" href="'+html(canonical)+'"><title>'+html(item.title)+'</title><main style="font:16px system-ui;max-width:760px;margin:8vh auto;padding:25px;white-space:pre-wrap"><h1>'+html(item.title)+'</h1>'+html(item.body)+'</main>');
  }));
  // Keep old links usable only when their target is unambiguous. Never guess/delete a page.
  app.get('/info/:contentSlug',wrap(async(req,res)=>{
    if (!slug(req.params.contentSlug)) return res.status(404).send('Not found');
    if (await maintenance(pool)) return res.status(503).type('text/plain').send('Maintenance in progress');
    const q=await pool.query("SELECT kind,slug,status FROM gameops_content WHERE slug=$1 AND status='published' AND kind IN ('page','policy') ORDER BY kind",[req.params.contentSlug]);
    if (!q.rowCount) return res.status(404).send('Not found');
    if (q.rowCount>1) return res.status(409).json({error:'Ambiguous legacy content URL',code:'AMBIGUOUS_CONTENT_URL',canonicalPaths:q.rows.map(publicPath)});
    res.redirect(308,publicPath(q.rows[0]));
  }));
}
module.exports = { mount, publicPath, publicOrigin, inspectConflicts };
