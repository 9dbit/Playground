"use strict";
const { wrap } = require('./auth');
const { fail, text, asJson, transaction, audit, defaults, period, C } = require('./core');
const seed = require('./storefront-seed.json');
const FRONT = 'https://playground-agent-frontend-production.up.railway.app';
function bindTenant(pool) {
  return wrap(async (req,res,next) => {
    const slug = req.get('X-Playground-Tenant');
    if (slug) {
      const t = (await pool.query('SELECT id,slug FROM agency_tenants WHERE slug=$1',[slug])).rows[0];
      if (!t || (req.agencySite && req.agencySite.id !== t.id)) fail(403,'Website agen berbeda');
      req.agencySite = t;
    }
    next();
  });
}
async function ensure64cor(pool) {
  // One-time bootstrap for the authorized sandbox; never reset existing content, staff or balances.
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(640064)");
    const found = await db.query("SELECT id FROM agency_tenants WHERE slug='64cor'");
    if (found.rowCount) return found.rows[0];
    const t = (await db.query("INSERT INTO agency_tenants(slug,name,policy,website) VALUES('64cor','64COR',$1,$2) RETURNING *",[asJson(defaults()),asJson({published:true,title:'64COR',description:'Selamat datang di 64COR',accent:'#c62d29'})])).rows[0];
    await db.query("INSERT INTO agency_gateway_accounts(tenant_id,mode,deposit_account,withdrawal_account,verified) VALUES($1,'SHARED',$2,$2,true)",[t.id,'sim:'+t.id+':deposit']);
    await db.query("INSERT INTO agency_contracts(tenant_id,effective_period,basis,rate_bps,terms) VALUES($1,$2,'net',2000,'{}')",[t.id,period()]);
    await db.query("INSERT INTO agency_games(tenant_id,game_id,entitled,selected) SELECT $1,id,true,true FROM gameops_games WHERE slug IN ('uno-luck','mahjong-wild','skygate-5000')",[t.id]);
    const promotionPaths = Object.fromEntries(seed.promotions.map((p,i)=>['/promotions/all/'+p.id,'/promotions/all/promo-'+String(i+1).padStart(2,'0')]));
    const pages = [{slug:'home',title:'64COR',description:'Selamat datang di 64COR! Jelajahi permainan Soft Tech.',banner_url:seed.banners[0].image,link_url:seed.banners[0].path},
      ...seed.banners.slice(1).map((b,i)=>({slug:'banner-'+String(i+1).padStart(2,'0'),title:b.title,banner_url:b.image,link_url:promotionPaths[b.path]||b.path})),
      ...seed.promotions.map((p,i)=>({slug:'promo-'+String(i+1).padStart(2,'0'),title:p.title,description:p.summary,body:(p.terms||[]).join('\n'),banner_url:p.banner||p.image,link_url:'/promotions/all'}))];
    for (const p of pages) {
      const body = {...p,accent:'#c62d29',robots:'noindex, nofollow'};delete body.slug;
      if(body.banner_url?.startsWith('/assets/'))body.banner_url=FRONT+body.banner_url;
      const c=(await db.query('INSERT INTO agency_content(tenant_id,slug,draft,published) VALUES($1,$2,$3,$3) RETURNING id',[t.id,p.slug,asJson(body)])).rows[0];
      await db.query("INSERT INTO agency_content_revisions(tenant_id,content_id,version,body,actor) VALUES($1,$2,1,$3,'storefront-bootstrap')",[t.id,c.id,asJson(body)]);
    }
    await audit(db,t.id,'storefront-bootstrap','storefront.connected',t.id,{slug:'64cor',origin:FRONT});
    return t;
  });
}
function mount({app,pool,agency}) {
  app.get('/api/storefront/:slug', wrap(async(req,res)=>{
    const t=(await pool.query("SELECT id,slug,name,status,environment,currency,coin_scale,website FROM agency_tenants WHERE slug=$1",[req.params.slug])).rows[0];
    if(!t || !t.website.published || !['sandbox','active'].includes(t.status))fail(404,'Website belum tersedia');
    const pages=(await pool.query('SELECT slug,published,version FROM agency_content WHERE tenant_id=$1 AND published IS NOT NULL ORDER BY slug',[t.id])).rows.map(c=>({slug:c.slug,...c.published}));
    const games=(await pool.query(`SELECT g.id,g.slug,g.name,g.status,r.readiness FROM agency_games a JOIN gameops_games g ON g.id=a.game_id LEFT JOIN agency_game_releases r ON r.game_id=g.id WHERE a.tenant_id=$1 AND a.selected AND a.entitled ORDER BY a.position,g.name`,[t.id])).rows;
    res.set('Cache-Control','no-store').json({tenant:{id:t.id,slug:t.slug,name:t.name,environment:t.environment,currency:t.currency},pages,games,capabilities:{gateway:'simulation',bonus:false,referral:false,leaderboard:false},admin_url:'/agency?tenant='+t.slug});
  }));
  app.put('/api/player/profile',wrap(async(req,res)=>{
    const a=req.agency,p=req.body;
    const name=text(p.name,100),email=String(p.email||'').trim();
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length>200)fail(400,'Email tidak valid');
    await pool.query("UPDATE agency_players SET display_name=$3,profile=profile||$4::jsonb WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,name,asJson({email})]);
    await audit(pool,a.tenant_id,a.id,'player.profile_updated',a.id);
    res.json({ok:true});
  }));
  app.put('/api/player/preferences',wrap(async(req,res)=>{
    const a=req.agency,p=req.body;
    if(!Array.isArray(p.favorites)||p.favorites.length>300||p.favorites.some(x=>typeof x!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(x)))fail(400,'Favorit tidak valid');
    if(p.read_messages && (!Array.isArray(p.read_messages)||p.read_messages.length>100||p.read_messages.some(x=>typeof x!=='string'||!/^[a-f0-9-]{36}$/.test(x))))fail(400,'Pesan tidak valid');
    await pool.query('UPDATE agency_players SET profile=profile||$3::jsonb WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id,asJson({favorites:p.favorites,...(p.read_messages?{read_messages:p.read_messages}:{})})]);res.json({ok:true});
  }));
  app.post('/api/player/auth/password',wrap(async(req,res)=>{
    const a=req.agency;
    if(!C.passwordValid(req.body.password))fail(400,'Password baru harus 15–128 karakter');
    await transaction(pool,async db=>{
      const p=(await db.query('SELECT password_hash FROM agency_players WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenant_id,a.id])).rows[0];
      if(!await C.passwordVerify(req.body.current_password,p.password_hash))fail(401,'Password saat ini salah');
      await db.query('UPDATE agency_players SET password_hash=$3,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,a.id,await C.passwordHash(req.body.password)]);
      await db.query('DELETE FROM agency_sessions WHERE tenant_id=$1 AND player_id=$2',[a.tenant_id,a.id]);
      await audit(db,a.tenant_id,a.id,'player.password_changed',a.id);
    });res.json({ok:true});
  }));
}
module.exports={mount,bindTenant,ensure64cor};
