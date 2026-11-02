'use strict';
const crypto=require('node:crypto');
const id=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(x);
const clean=(x,n=200)=>typeof x==='string'&&x.length<=n;
const num=x=>Number.isSafeInteger(x)&&x>=0&&x<=1000000000;
const percent=x=>Number.isInteger(x)&&x>=0&&x<=100;
const slug=x=>typeof x==='string'&&x.length<=80&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const fail=(res,status,error)=>res.status(status).json({error});
const types=['page','policy','template','frontend'];
const migration=[
"CREATE TABLE IF NOT EXISTS gameops_game_profiles(game_id uuid PRIMARY KEY REFERENCES gameops_games(id) ON DELETE CASCADE,demo_chance integer NOT NULL DEFAULT 50 CHECK(demo_chance BETWEEN 0 AND 100),invest_enabled boolean NOT NULL DEFAULT false,min_invest integer NOT NULL DEFAULT 1,max_invest integer NOT NULL DEFAULT 1000,trending boolean NOT NULL DEFAULT false,featured boolean NOT NULL DEFAULT false,instructions text NOT NULL DEFAULT '',image_bytes bytea,image_mime text,version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_player_profiles(player_id uuid PRIMARY KEY REFERENCES gameops_players(id) ON DELETE CASCADE,first_name text NOT NULL DEFAULT '',last_name text NOT NULL DEFAULT '',city text NOT NULL DEFAULT '',state text NOT NULL DEFAULT '',zip text NOT NULL DEFAULT '',country text NOT NULL DEFAULT '',admin_note text NOT NULL DEFAULT '',local_status text NOT NULL DEFAULT 'active' CHECK(local_status IN ('active','review','blocked_locally')),version integer NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_ticket_messages(id bigserial PRIMARY KEY,ticket_id uuid NOT NULL REFERENCES gameops_tickets(id) ON DELETE CASCADE,author text NOT NULL,body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_subscribers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'subscribed' CHECK(status IN ('subscribed','unsubscribed')),created_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_content(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('page','policy','template','frontend')),slug text NOT NULL,title text NOT NULL,body text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(kind,slug))",
"CREATE TABLE IF NOT EXISTS gameops_notifications(id bigserial PRIMARY KEY,recipient_ref text NOT NULL DEFAULT 'admin',title text NOT NULL,body text NOT NULL,channel text NOT NULL DEFAULT 'internal',status text NOT NULL DEFAULT 'recorded_only',created_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_login_history(id bigserial PRIMARY KEY,username text NOT NULL,success boolean NOT NULL,ip text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())",
"CREATE TABLE IF NOT EXISTS gameops_revoked_sessions(nonce text PRIMARY KEY,expires_at timestamptz NOT NULL,revoked_at timestamptz NOT NULL DEFAULT now())",
"CREATE INDEX IF NOT EXISTS gameops_content_status_idx ON gameops_content(kind,status)",
"CREATE INDEX IF NOT EXISTS gameops_login_time_idx ON gameops_login_history(created_at DESC)"
];
async function ensureSchema(pool){for(const sql of migration)await pool.query(sql)}
async function logLogin(pool,user,success,ip){
 await pool.query("INSERT INTO gameops_login_history(username,success,ip) VALUES($1,$2,$3)",[String(user||'unknown').slice(0,80),!!success,String(ip||'').slice(0,64)]);
}
async function isRevoked(pool,nonce){return !!(await pool.query("SELECT 1 FROM gameops_revoked_sessions WHERE nonce=$1",[nonce])).rowCount}
async function revoke(pool,session){await pool.query("INSERT INTO gameops_revoked_sessions(nonce,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING",[session.n,new Date(session.e)])}
function mount(app,{pool,audit}){
 app.get('/api/admin/deep/summary',wrap(async(req,res)=>{
  const [games,players,tickets,subs,content]=await Promise.all([
   pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='Active')::int AS active FROM gameops_games"),
   pool.query("SELECT count(*)::int AS total FROM gameops_players"),
   pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status!='Closed')::int AS open FROM gameops_tickets"),
   pool.query("SELECT count(*)::int AS total FROM gameops_subscribers WHERE status='subscribed'"),
   pool.query("SELECT count(*)::int AS total FROM gameops_content WHERE status='published'")
  ]);
  res.json({games:games.rows[0],players:players.rows[0],tickets:tickets.rows[0],subscribers:subs.rows[0].total,published:content.rows[0].total,integratedEngines:0,kind:'read_from_database'});
 }));
 app.get('/api/admin/deep/games',wrap(async(req,res)=>{
  const q=await pool.query("SELECT g.id,g.name,g.slug,g.code,g.platform,g.version,g.status,g.rounds::text,coalesce(c.trending,false) AS trending,coalesce(c.featured,false) AS featured,coalesce(c.version,1) AS config_version,(c.image_bytes IS NOT NULL) AS has_image FROM gameops_games g LEFT JOIN gameops_game_profiles c ON c.game_id=g.id ORDER BY g.name");
  res.json({items:q.rows,gameEngineConnected:false});
 }));
 app.get('/api/admin/deep/games/:gid',wrap(async(req,res)=>{
  if(!id(req.params.gid))return fail(res,400,'Invalid ID');
  const q=await pool.query("SELECT g.id,g.name,g.slug,g.code,g.platform,g.version AS build_version,g.status,g.rounds::text,coalesce(c.demo_chance,50) AS demo_chance,coalesce(c.invest_enabled,false) AS invest_enabled,coalesce(c.min_invest,1) AS min_invest,coalesce(c.max_invest,1000) AS max_invest,coalesce(c.trending,false) AS trending,coalesce(c.featured,false) AS featured,coalesce(c.instructions,'') AS instructions,coalesce(c.version,1) AS version,(c.image_bytes IS NOT NULL) AS has_image FROM gameops_games g LEFT JOIN gameops_game_profiles c ON c.game_id=g.id WHERE g.id=$1",[req.params.gid]);
  if(!q.rowCount)return fail(res,404,'Game not found');
  res.json({item:q.rows[0],note:'Simulation settings are demo-only; never modify live outcomes'});
 }));
 app.put('/api/admin/deep/games/:gid',wrap(async(req,res)=>{
  if(!id(req.params.gid))return fail(res,400,'Invalid ID');
  const p=req.body||{};
  if(!clean(p.name,100)||!p.name.trim()||!clean(p.code,12)||!clean(p.platform,80)||!percent(p.demo_chance)||typeof p.invest_enabled!=='boolean'||typeof p.trending!=='boolean'||typeof p.featured!=='boolean'||!num(p.min_invest)||!num(p.max_invest)||p.min_invest>p.max_invest||!clean(p.instructions,15000)||!Number.isInteger(p.version)||p.version<1)return fail(res,400,'Invalid game configuration');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const g=await client.query('SELECT id FROM gameops_games WHERE id=$1 FOR UPDATE',[req.params.gid]);
   if(!g.rowCount){await client.query('ROLLBACK');return fail(res,404,'Game not found')}
   await client.query('INSERT INTO gameops_game_profiles(game_id) VALUES($1) ON CONFLICT DO NOTHING',[req.params.gid]);
   const q=await client.query("UPDATE gameops_game_profiles SET demo_chance=$2,invest_enabled=$3,min_invest=$4,max_invest=$5,trending=$6,featured=$7,instructions=$8,version=version+1,updated_at=now() WHERE game_id=$1 AND version=$9 RETURNING version",[req.params.gid,p.demo_chance,p.invest_enabled,p.min_invest,p.max_invest,p.trending,p.featured,p.instructions,p.version]);
   if(!q.rowCount){await client.query('ROLLBACK');return fail(res,409,'Configuration changed elsewhere; reload')}
   await client.query("UPDATE gameops_games SET name=$2,code=$3,platform=$4,updated_at=now() WHERE id=$1",[req.params.gid,p.name.trim(),p.code,p.platform]);
   await client.query('COMMIT');
   await audit('game.config.updated',req.params.gid,{version:q.rows[0].version,demoOnly:true});
   res.json({ok:true,version:q.rows[0].version,externalEngineAffected:false});
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }));
 app.post('/api/admin/deep/games/:gid/image',wrap(async(req,res)=>{
  if(!id(req.params.gid))return fail(res,400,'Invalid ID');
  const raw=req.body?.data;
  if(typeof raw!=='string'||raw.length>720000)return fail(res,400,'Image too large (maximum 500 KB)');
  const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if(!m)return fail(res,400,'PNG, JPG or WebP required');
  const b=Buffer.from(m[2],'base64');
  const valid=(m[1]==='image/png'&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))||(m[1]==='image/jpeg'&&b[0]===255&&b[1]===216)||(m[1]==='image/webp'&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP');
  if(!valid||b.length>500000)return fail(res,400,'Invalid image bytes');
  const q=await pool.query('UPDATE gameops_game_profiles SET image_bytes=$2,image_mime=$3,updated_at=now() WHERE game_id=$1 RETURNING game_id',[req.params.gid,b,m[1]]);
  if(!q.rowCount)return fail(res,409,'Save game configuration before uploading image');
  await audit('game.image.updated',req.params.gid,{mime:m[1],size:b.length});
  res.json({ok:true});
 }));
 app.get('/api/admin/deep/games/:gid/image',wrap(async(req,res)=>{
  if(!id(req.params.gid))return fail(res,400,'Invalid ID');
  const q=await pool.query('SELECT image_bytes,image_mime FROM gameops_game_profiles WHERE game_id=$1',[req.params.gid]);
  if(!q.rowCount||!q.rows[0].image_bytes)return fail(res,404,'No image');
  res.type(q.rows[0].image_mime).send(q.rows[0].image_bytes);
 }));
 app.get('/api/admin/deep/players',wrap(async(req,res)=>{
  const state=String(req.query.state||'all');
  const q=await pool.query("SELECT p.id,p.player_ref,p.game_id,g.name AS game,p.rounds::text,p.last_seen,coalesce(m.first_name,'') AS first_name,coalesce(m.last_name,'') AS last_name,coalesce(m.local_status,'active') AS local_status FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id LEFT JOIN gameops_player_profiles m ON m.player_id=p.id ORDER BY p.last_seen DESC LIMIT 200");
  const items=q.rows.filter(x=>state==='all'||(state==='active'&&x.local_status==='active')||(state==='banned'&&x.local_status==='blocked_locally')||(state==='review'&&x.local_status==='review'));
  res.json({items,note:'Pseudonymous players from signed events; local block not enforced in external game'});
 }));
 app.get('/api/admin/deep/players/:pid',wrap(async(req,res)=>{
  if(!id(req.params.pid))return fail(res,400,'Invalid ID');
  const q=await pool.query("SELECT p.id,p.player_ref,p.game_id,g.name AS game,p.rounds::text,p.last_seen,coalesce(m.first_name,'') AS first_name,coalesce(m.last_name,'') AS last_name,coalesce(m.city,'') AS city,coalesce(m.state,'') AS state,coalesce(m.zip,'') AS zip,coalesce(m.country,'') AS country,coalesce(m.admin_note,'') AS admin_note,coalesce(m.local_status,'active') AS local_status,coalesce(m.version,1) AS version,coalesce(sum(e.stake),0)::text AS total_played,coalesce(sum(e.payout),0)::text AS total_win,(coalesce(sum(e.payout),0)-coalesce(sum(e.stake),0))::text AS net_return FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id LEFT JOIN gameops_player_profiles m ON m.player_id=p.id LEFT JOIN gameops_events e ON e.game_id=p.game_id AND e.player_ref=p.player_ref WHERE p.id=$1 GROUP BY p.id,g.name,m.player_id",[req.params.pid]);
  if(!q.rowCount)return fail(res,404,'Player not found');
  res.json({item:q.rows[0],balanceEnabled:false,kycConnected:false,impersonationEnabled:false});
 }));
 app.put('/api/admin/deep/players/:pid',wrap(async(req,res)=>{
  if(!id(req.params.pid))return fail(res,400,'Invalid ID');
  const p=req.body||{},fields=['first_name','last_name','city','state','zip','country'];
  if(fields.some(k=>!clean(p[k],120))||!clean(p.admin_note,1500)||!['active','review','blocked_locally'].includes(p.local_status)||!Number.isInteger(p.version)||p.version<1)return fail(res,400,'Invalid player metadata');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const exists=await client.query('SELECT id FROM gameops_players WHERE id=$1 FOR UPDATE',[req.params.pid]);
   if(!exists.rowCount){await client.query('ROLLBACK');return fail(res,404,'Player not found')}
   await client.query('INSERT INTO gameops_player_profiles(player_id) VALUES($1) ON CONFLICT DO NOTHING',[req.params.pid]);
   const q=await client.query('UPDATE gameops_player_profiles SET first_name=$2,last_name=$3,city=$4,state=$5,zip=$6,country=$7,admin_note=$8,local_status=$9,version=version+1,updated_at=now() WHERE player_id=$1 AND version=$10 RETURNING version',[req.params.pid,p.first_name,p.last_name,p.city,p.state,p.zip,p.country,p.admin_note,p.local_status,p.version]);
   if(!q.rowCount){await client.query('ROLLBACK');return fail(res,409,'Profile changed elsewhere; reload')}
   await client.query('COMMIT');
   await audit('player.metadata.updated',req.params.pid,{version:q.rows[0].version,status:p.local_status});
   res.json({ok:true,version:q.rows[0].version,externalGameAffected:false});
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }));
 app.get('/api/admin/deep/players/:pid/rounds',wrap(async(req,res)=>{
  if(!id(req.params.pid))return fail(res,400,'Invalid ID');
  const q=await pool.query('SELECT e.id::text,e.event_id,e.round_id,e.stake::text,e.payout::text,e.currency,e.occurred_at,g.name AS game FROM gameops_players p JOIN gameops_events e ON e.game_id=p.game_id AND e.player_ref=p.player_ref JOIN gameops_games g ON g.id=e.game_id WHERE p.id=$1 ORDER BY e.id DESC LIMIT 200',[req.params.pid]);
  res.json({items:q.rows});
 }));
 app.get('/api/admin/deep/rounds',wrap(async(req,res)=>{
 const q=await pool.query('SELECT e.id::text,e.event_id,e.round_id,e.player_ref,e.stake::text,e.payout::text,e.currency,e.occurred_at,g.name AS game FROM gameops_events e JOIN gameops_games g ON g.id=e.game_id ORDER BY e.id DESC LIMIT 200');
 res.json({items:q.rows});
 }));
 app.get('/api/admin/deep/rounds/:rid',wrap(async(req,res)=>{
  if(!/^[1-9][0-9]{0,18}$/.test(req.params.rid))return fail(res,400,'Invalid round ID');
  const q=await pool.query('SELECT e.id::text,e.event_id,e.round_id,e.player_ref,e.stake::text,e.payout::text,e.currency,e.occurred_at,e.ingested_at,g.name AS game FROM gameops_events e JOIN gameops_games g ON g.id=e.game_id WHERE e.id=$1',[req.params.rid]);
  if(!q.rowCount)return fail(res,404,'Round not found');
  res.json({item:q.rows[0],immutable:true});
 }));
 app.get('/api/admin/deep/tickets/:tid',wrap(async(req,res)=>{
  if(!id(req.params.tid))return fail(res,400,'Invalid ID');
  const [t,m]=await Promise.all([pool.query('SELECT * FROM gameops_tickets WHERE id=$1',[req.params.tid]),pool.query('SELECT id::text,author,body,created_at FROM gameops_ticket_messages WHERE ticket_id=$1 ORDER BY id',[req.params.tid])]);
  if(!t.rowCount)return fail(res,404,'Ticket not found');
  res.json({item:t.rows[0],messages:m.rows,externalDelivery:false});
 }));
 app.post('/api/admin/deep/tickets/:tid/replies',wrap(async(req,res)=>{
  if(!id(req.params.tid)||!clean(req.body?.body,4000)||!req.body.body.trim())return fail(res,400,'Invalid ticket reply');
  const q=await pool.query("INSERT INTO gameops_ticket_messages(ticket_id,author,body) SELECT id,'admin',$2 FROM gameops_tickets WHERE id=$1 RETURNING id::text",[req.params.tid,req.body.body.trim()]);
  if(!q.rowCount)return fail(res,404,'Ticket not found');
  await audit('ticket.reply.recorded',req.params.tid,{messageId:q.rows[0].id});
  res.status(201).json({item:q.rows[0],sentExternally:false});
 }));
 app.get('/api/admin/deep/requests/:rid',wrap(async(req,res)=>{
  if(!id(req.params.rid))return fail(res,400,'Invalid ID');
  const q=await pool.query('SELECT id,player_ref,amount::text,status,note,created_at,reviewed_at FROM gameops_requests WHERE id=$1',[req.params.rid]);
  if(!q.rowCount)return fail(res,404,'Request not found');
  res.json({item:q.rows[0],settlementEnabled:false});
 }));
 app.get('/api/admin/deep/reports/:kind',wrap(async(req,res)=>{
  let q,notice;
  if(req.params.kind==='transactions'){const result=req.query.result||'all';
   if(!['all','win','loss','draw'].includes(result))return fail(res,400,'Unknown round result filter');
   q=await pool.query("SELECT e.id::text,e.event_id,e.round_id,g.name AS game,e.player_ref,e.stake::text,e.payout::text,e.currency,e.occurred_at,CASE WHEN e.payout>e.stake THEN 'win' WHEN e.payout<e.stake THEN 'loss' ELSE 'draw' END AS result FROM gameops_events e JOIN gameops_games g ON g.id=e.game_id WHERE ($1='all' OR ($1='win' AND e.payout>e.stake) OR ($1='loss' AND e.payout<e.stake) OR ($1='draw' AND e.payout=e.stake)) ORDER BY e.id DESC LIMIT 200",[result]);
   notice='Derived net result from observed stake/payout only; not proof of Xaxino win_status or final game settlement';}
  else if(req.params.kind==='logins'){q=await pool.query('SELECT id::text,username,success,ip,created_at FROM gameops_login_history ORDER BY id DESC LIMIT 200');notice='Admin login history only'}
  else if(req.params.kind==='notifications'){q=await pool.query('SELECT id::text,recipient_ref,title,channel,status,created_at FROM gameops_notifications ORDER BY id DESC LIMIT 200');notice='Internal records, not delivered'}
  else if(req.params.kind==='transfers'){q=await pool.query("SELECT id::text,source_player_id::text AS source,target_player_id::text AS target,amount::text,actor,note,created_at FROM gameops_virtual_wallet_operations WHERE action='transfer' ORDER BY created_at DESC LIMIT 200");notice='Internal DEMO_COIN transfers only; no external wallet settlement'}
  else return fail(res,404,'Report unknown');
  res.json({items:q.rows,notice,connected:true,externalWalletConnected:false});
 }));
 app.post('/api/admin/deep/notifications',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!clean(p.recipient_ref,120)||!p.recipient_ref.trim()||!clean(p.title,180)||!p.title.trim()||!clean(p.body,2000)||!p.body.trim())return fail(res,400,'Invalid notification');
  const q=await pool.query("INSERT INTO gameops_notifications(recipient_ref,title,body) VALUES($1,$2,$3) RETURNING id::text",[p.recipient_ref.trim(),p.title.trim(),p.body.trim()]);
  await audit('notification.recorded',q.rows[0].id,{});
  res.status(201).json({item:q.rows[0],sent:false});
 }));
 app.get('/api/admin/deep/subscribers',wrap(async(req,res)=>{
  const q=await pool.query('SELECT id,contact,status,created_at FROM gameops_subscribers ORDER BY created_at DESC LIMIT 200');
  res.json({items:q.rows,externalDelivery:false});
 }));
 app.post('/api/admin/deep/subscribers',wrap(async(req,res)=>{
  const email=req.body?.contact;
  if(typeof email!=='string'||!/^([^@\s]+)@([^@\s]+)\.([^@\s]+)$/.test(email)||email.length>200)return fail(res,400,'Valid email required');
  const q=await pool.query('INSERT INTO gameops_subscribers(contact) VALUES($1) ON CONFLICT(contact) DO NOTHING RETURNING id',[email.toLowerCase()]);
  if(!q.rowCount)return fail(res,409,'Subscriber exists');
  await audit('subscriber.created',q.rows[0].id,{});
  res.status(201).json({item:q.rows[0]});
 }));
 app.patch('/api/admin/deep/subscribers/:sid',wrap(async(req,res)=>{
  if(!id(req.params.sid)||!['subscribed','unsubscribed'].includes(req.body?.status))return fail(res,400,'Invalid subscriber');
  const q=await pool.query('UPDATE gameops_subscribers SET status=$2 WHERE id=$1 RETURNING id,status',[req.params.sid,req.body.status]);
  if(!q.rowCount)return fail(res,404,'Subscriber not found');
  await audit('subscriber.status.updated',req.params.sid,{status:req.body.status});
  res.json({item:q.rows[0]});
 }));
 app.get('/api/admin/deep/content/:kind',wrap(async(req,res)=>{
  if(!types.includes(req.params.kind))return fail(res,404,'Content type unknown');
  const q=await pool.query('SELECT id,kind,slug,title,status,version,updated_at FROM gameops_content WHERE kind=$1 ORDER BY updated_at DESC LIMIT 200',[req.params.kind]);
  res.json({items:q.rows});
 }));
 app.post('/api/admin/deep/content/:kind',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!types.includes(req.params.kind)||!slug(p.slug)||!clean(p.title,180)||!p.title.trim()||!clean(p.body,20000)||!['draft','published'].includes(p.status))return fail(res,400,'Invalid content');
  const q=await pool.query('INSERT INTO gameops_content(kind,slug,title,body,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(kind,slug) DO NOTHING RETURNING id',[req.params.kind,p.slug,p.title,p.body,p.status]);
  if(!q.rowCount)return fail(res,409,'Slug already exists');
  await audit('content.created',q.rows[0].id,{kind:req.params.kind});
  res.status(201).json({item:q.rows[0]});
 }));
 app.get('/api/admin/deep/content/:kind/:cid',wrap(async(req,res)=>{
  if(!types.includes(req.params.kind)||!id(req.params.cid))return fail(res,400,'Invalid content');
  const q=await pool.query('SELECT * FROM gameops_content WHERE kind=$1 AND id=$2',[req.params.kind,req.params.cid]);
  if(!q.rowCount)return fail(res,404,'Content not found');
  res.json({item:q.rows[0]});
 }));
 app.put('/api/admin/deep/content/:kind/:cid',wrap(async(req,res)=>{
  const p=req.body||{};
  if(!types.includes(req.params.kind)||!id(req.params.cid)||!slug(p.slug)||!clean(p.title,180)||!p.title.trim()||!clean(p.body,20000)||!['draft','published'].includes(p.status)||!Number.isInteger(p.version))return fail(res,400,'Invalid content');
  const q=await pool.query('UPDATE gameops_content SET slug=$3,title=$4,body=$5,status=$6,version=version+1,updated_at=now() WHERE kind=$1 AND id=$2 AND version=$7 RETURNING id,version',[req.params.kind,req.params.cid,p.slug,p.title,p.body,p.status,p.version]);
  if(!q.rowCount)return fail(res,409,'Content not found or version conflict');
  await audit('content.updated',req.params.cid,{kind:req.params.kind,version:q.rows[0].version});
  res.json({item:q.rows[0]});
 }));
 app.get('/api/admin/deep/system/:name',wrap(async(req,res)=>{
  if(!['server','application','cache','update','cron','security'].includes(req.params.name))return fail(res,404,'Unknown module');
  res.json({name:req.params.name,readOnly:true,asOf:new Date().toISOString(),appVersion:'0.7.0',mfaEnabled:false,rbacEnabled:false,gameControlConnected:false,message:'Read-only status. Destructive maintenance is disabled.'});
 }));
 app.get('/robots.txt',wrap(async(req,res)=>{
  const q=await pool.query("SELECT value FROM gameops_settings WHERE key='robots'");
  const rules=q.rows[0]?.value?.rules;
  res.type('text/plain').send(typeof rules==='string'&&rules.length<4000?rules:'User-agent: *\nDisallow: /engine\nDisallow: /api/\nDisallow: /login\n');
 }));
 app.get('/sitemap.xml',wrap(async(req,res)=>{
  const q=await pool.query("SELECT slug FROM gameops_content WHERE status='published' AND kind IN ('page','policy') ORDER BY slug LIMIT 1000");
  const base='https://playground-admin-production.up.railway.app';
  const entries=q.rows.map(x=>'  <url><loc>'+escape(base+'/info/'+x.slug)+'</loc></url>').join('\n');
  res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+entries+'\n</urlset>');
 }));
 app.get('/info/:contentSlug',wrap(async(req,res)=>{
  if(!slug(req.params.contentSlug))return res.status(404).send('Not found');
  const [c,m]=await Promise.all([pool.query("SELECT title,body FROM gameops_content WHERE slug=$1 AND status='published' AND kind IN ('page','policy') LIMIT 1",[req.params.contentSlug]),pool.query("SELECT value FROM gameops_settings WHERE key='maintenance'")]);
  if(m.rows[0]?.value?.enabled===true)return res.status(503).type('text/plain').send('Maintenance in progress');
  if(!c.rowCount)return res.status(404).send('Not found');
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(c.rows[0].title)+'</title><main style="font:16px system-ui;max-width:760px;margin:8vh auto;padding:25px;white-space:pre-wrap"><h1>'+escape(c.rows[0].title)+'</h1>'+escape(c.rows[0].body)+'</main>');
 }));
}
module.exports={ensureSchema,mount,logLogin,isRevoked,revoke};
