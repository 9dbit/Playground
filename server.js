'use strict';
(function server(){
'use strict';
const express = require('express');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const path = require('node:path');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const EVENT_SECRET = process.env.GAME_EVENT_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
for (const [k,v] of Object.entries({DATABASE_URL,ADMIN_USERNAME,ADMIN_PASSWORD,SESSION_SECRET,GAME_EVENT_SECRET:EVENT_SECRET})) {
  if (!v) throw new Error('Missing required environment variable: ' + k);
}
if (ADMIN_PASSWORD.length < 18 || SESSION_SECRET.length < 32 || EVENT_SECRET.length < 32) {
  throw new Error('Admin password or signing secrets are too short');
}
const pool = new Pool({ connectionString:DATABASE_URL, max:8, idleTimeoutMillis:30000, connectionTimeoutMillis:10000 });
const iso = () => new Date().toISOString();
const valid = (s,max=120) => typeof s==='string' && s.length>0 && s.length<=max;
const safeInt = x => Number.isSafeInteger(x) && x>=0 && x<=1000000000000;
const secretEqual = (a,b) => {
  const x=crypto.createHash('sha256').update(String(a)).digest();
  const y=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x,y);
};
function sign(s){return crypto.createHmac('sha256',SESSION_SECRET).update(s).digest('base64url');}
function cookieValue(req,name){
  const m=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return m ? m.slice(name.length+1) : '';
}
function getSession(req){
  const raw=cookieValue(req,'gameops_session');
  const idx=raw.lastIndexOf('.');
  if(idx<1)return null;
  const body=raw.slice(0,idx), sig=raw.slice(idx+1);
  if(!secretEqual(sig,sign(body)))return null;
  try{
    const data=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(data.u!==ADMIN_USERNAME || !valid(data.n,64) || data.e<Date.now())return null;
    return data;
  }catch{return null;}
}
function startSession(res){
  const data={u:ADMIN_USERNAME,n:crypto.randomBytes(18).toString('hex'),e:Date.now()+8*60*60*1000};
  const payload=Buffer.from(JSON.stringify(data)).toString('base64url');
  res.cookie('gameops_session',payload+'.'+sign(payload),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:8*60*60*1000,path:'/'});
  return data;
}
function csrf(s){return sign(s.n+':csrf');}
const hits=new Map();
function limit(key,max=12,period=60000){
 const t=Date.now();const old=hits.get(key)||[];const next=old.filter(v=>v>t-period);
 next.push(t);hits.set(key,next);return next.length<=max;
}
setInterval(()=>{if(hits.size>4000)hits.clear();},60000).unref();
app.disable('x-powered-by');app.set('trust proxy',1);
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 next();
});
app.use(express.json({limit:'80kb',verify:(req,res,b)=>{req.rawBody=Buffer.from(b);}}));
function auth(req,res,next){
 const s=getSession(req);if(!s)return res.status(401).json({error:'Unauthorized',code:'LOGIN_REQUIRED'});
 req.admin=s;
 if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
   if(!secretEqual(req.headers['x-csrf-token']||'',csrf(s)))return res.status(403).json({error:'CSRF token invalid'});
 }
 next();
}
function route(fn){return (req,res,next)=>Promise.resolve(fn(req,res)).catch(next);}
function error(res,status,reason){return res.status(status).json({error:reason});}
async function audit(action,resource,details={}){
 await pool.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',[ADMIN_USERNAME,action,resource,JSON.stringify(details)]);
}
const ddl=`
CREATE TABLE IF NOT EXISTS gameops_games (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL, slug text NOT NULL UNIQUE, code text NOT NULL DEFAULT '',
 platform text NOT NULL DEFAULT 'Web / PWA',
 version text NOT NULL DEFAULT '0.1.0',
 status text NOT NULL DEFAULT 'Maintenance' CHECK (status IN ('Active','Maintenance')),
 rounds bigint NOT NULL DEFAULT 0 CHECK(rounds>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_settings (
 key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text NOT NULL DEFAULT 'system'
);
CREATE TABLE IF NOT EXISTS gameops_players (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES gameops_games(id),
 player_ref text NOT NULL, rounds bigint NOT NULL DEFAULT 0,
 last_seen timestamptz NOT NULL DEFAULT now(), UNIQUE(game_id,player_ref)
);
CREATE TABLE IF NOT EXISTS gameops_events (
 id bigserial PRIMARY KEY, event_id text NOT NULL UNIQUE,
 game_id uuid NOT NULL REFERENCES gameops_games(id), round_id text NOT NULL, player_ref text NOT NULL,
 stake bigint NOT NULL CHECK(stake>=0), payout bigint NOT NULL CHECK(payout>=0),
 currency text NOT NULL DEFAULT 'DEMO_COIN',
 occurred_at timestamptz NOT NULL, ingested_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(game_id,round_id)
);
CREATE TABLE IF NOT EXISTS gameops_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_ref text NOT NULL,
 amount bigint NOT NULL CHECK(amount>0), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 note text, created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE TABLE IF NOT EXISTS gameops_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject text NOT NULL, requester_ref text NOT NULL,
 priority text NOT NULL DEFAULT 'Medium', status text NOT NULL DEFAULT 'Open',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_audit (
 id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,
 resource text NOT NULL,details jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gameops_events_time_idx ON gameops_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS gameops_events_game_time_idx ON gameops_events(game_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS gameops_audit_time_idx ON gameops_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS gameops_players_last_seen_idx ON gameops_players(last_seen DESC);
`;
async function initDB(){
 await pool.query(ddl);
 for(const [name,slug,code] of [['Skygate 5000','skygate-5000','SK'],['UNO LUCK','uno-luck','UN'],['Mahjong Wild','mahjong-wild','MW']]){
  await pool.query("INSERT INTO gameops_games(name,slug,code) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING",[name,slug,code]);
 }
}
app.get('/health',route(async(req,res)=>{
 try{await pool.query('SELECT 1');res.json({status:'ok',service:'playground-gameops',db:'connected',time:iso()});}
 catch{res.status(503).json({status:'degraded',db:'unavailable'});}
}));
app.get('/login',(req,res)=>getSession(req)?res.redirect('/engine'):res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/logout',(req,res)=>{res.clearCookie('gameops_session',{path:'/'});res.redirect('/login');});
app.post('/api/auth/login',(req,res)=>{
 if(!limit('login:'+(req.ip||'unknown'),8,15*60000))return error(res,429,'Too many login attempts');
 const {username,password}=req.body||{};
 if(!secretEqual(username,ADMIN_USERNAME) || !secretEqual(password,ADMIN_PASSWORD))return error(res,401,'Invalid credentials');
 const s=startSession(res);res.json({ok:true,username:ADMIN_USERNAME,csrf:csrf(s)});
});
app.get('/api/auth/session',(req,res)=>{
 const s=getSession(req); if(!s)return error(res,401,'Login required');
 res.json({username:s.u,csrf:csrf(s),expiresAt:new Date(s.e).toISOString()});
});
app.post('/api/auth/logout',auth,(req,res)=>{res.clearCookie('gameops_session',{path:'/'});res.json({ok:true});});
app.get('/',(req,res)=>res.redirect(getSession(req)?'/engine':'/login'));
app.get('/engine',(req,res)=>getSession(req)?res.sendFile(path.join(__dirname,'public','engine.html')):res.redirect('/login'));
app.get('/preview',(req,res)=>getSession(req)?res.sendFile(path.join(__dirname,'public','preview.html')):res.redirect('/login'));
app.get('/assets/engine.js',(req,res)=>getSession(req)?res.sendFile(path.join(__dirname,'public','engine.js')):res.status(401).end());
app.get('/assets/engine.css',(req,res)=>res.sendFile(path.join(__dirname,'public','engine.css')));
app.use('/api/admin',auth);
app.get('/api/admin/summary',route(async(req,res)=>{
 const [g,p,r,ev]=await Promise.all([
  pool.query('SELECT count(*)::int AS count,count(*) FILTER (WHERE status=$1)::int AS active FROM gameops_games',['Active']),
  pool.query('SELECT count(*)::int AS count FROM gameops_players'),
  pool.query('SELECT count(*)::int AS count FROM gameops_requests WHERE status=$1',['pending']),
  pool.query('SELECT count(*)::int AS rounds, COALESCE(sum(stake),0)::text AS stake,COALESCE(sum(payout),0)::text AS payout FROM gameops_events')
 ]);
 const e=ev.rows[0];res.json({gameCount:g.rows[0].count,activeGames:g.rows[0].active,players:p.rows[0].count,pendingRequests:r.rows[0].count,rounds:e.rounds,stake:e.stake,payout:e.payout,margin:(BigInt(e.stake)-BigInt(e.payout)).toString(),currency:'DEMO_COIN',sample:false,asOf:iso()});
}));
app.get('/api/admin/games',route(async(req,res)=>{
 const q=await pool.query('SELECT id,name,slug,code,platform,version,status,rounds::text AS rounds,created_at FROM gameops_games ORDER BY created_at,id');
 res.json({items:q.rows});
}));
app.post('/api/admin/games',route(async(req,res)=>{
 const {name,slug,code,platform}=req.body||{};
 if(!valid(name,80)||!valid(slug,60)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||!valid(code,6)||!valid(platform||'Web / PWA',60))return error(res,400,'Invalid game fields');
 const q=await pool.query('INSERT INTO gameops_games(name,slug,code,platform) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO NOTHING RETURNING *',[name,slug,code,String(platform||'Web / PWA')]);
 if(!q.rowCount)return error(res,409,'Game slug exists');
 await audit('game.created',q.rows[0].id,{name,slug});res.status(201).json({item:q.rows[0]});
}));
app.patch('/api/admin/games/:id',route(async(req,res)=>{
 const {status}=req.body||{};
 if(!['Active','Maintenance'].includes(status))return error(res,400,'Invalid status');
 const q=await pool.query('UPDATE gameops_games SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
 if(!q.rowCount)return error(res,404,'Game not found');
 await audit('game.status_changed',req.params.id,{status});res.json({item:q.rows[0],notice:'This setting does not remotely pause an independent game engine'});
}));
app.get('/api/admin/players',route(async(req,res)=>{
 const q=await pool.query('SELECT p.id,p.player_ref,g.name AS game,p.rounds::text AS rounds,p.last_seen FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id ORDER BY p.last_seen DESC LIMIT 200');
 res.json({items:q.rows});
}));
app.get('/api/admin/rounds',route(async(req,res)=>{
 const q=await pool.query('SELECT e.event_id,e.round_id,g.name AS game,e.player_ref,e.stake::text,e.payout::text,e.currency,e.occurred_at FROM gameops_events e JOIN gameops_games g ON g.id=e.game_id ORDER BY e.occurred_at DESC LIMIT 200');
 res.json({items:q.rows});
}));
app.get('/api/admin/audit',route(async(req,res)=>{
 const q=await pool.query('SELECT id::text,actor,action,resource,details,created_at FROM gameops_audit ORDER BY id DESC LIMIT 200');res.json({items:q.rows});
}));
app.get('/api/admin/requests',route(async(req,res)=>{
 const q=await pool.query('SELECT id,player_ref,amount::text,status,note,created_at,reviewed_at FROM gameops_requests ORDER BY created_at DESC LIMIT 200');res.json({items:q.rows,notice:'Approval is metadata only; no wallet credit or settlement is performed'});
}));
app.patch('/api/admin/requests/:id',route(async(req,res)=>{
 const {status,note}=req.body||{};
 if(!['approved','rejected'].includes(status) || (note!=null&&!valid(note,500)))return error(res,400,'Invalid decision');
 const q=await pool.query("UPDATE gameops_requests SET status=$1,note=$2,reviewed_at=now() WHERE id=$3 AND status='pending' RETURNING *",[status,note||null,req.params.id]);
 if(!q.rowCount)return error(res,409,'Not found or already reviewed');
 await audit('request.reviewed',req.params.id,{status});res.json({item:q.rows[0],settled:false});
}));
app.get('/api/admin/tickets',route(async(req,res)=>{
 const q=await pool.query('SELECT * FROM gameops_tickets ORDER BY created_at DESC LIMIT 200');res.json({items:q.rows});
}));
app.post('/api/admin/tickets',route(async(req,res)=>{
 const {subject,requester_ref,priority}=req.body||{};
 if(!valid(subject,200)||!valid(requester_ref,120)||!['Low','Medium','High'].includes(priority||'Medium'))return error(res,400,'Invalid ticket fields');
 const q=await pool.query('INSERT INTO gameops_tickets(subject,requester_ref,priority) VALUES($1,$2,$3) RETURNING *',[subject,requester_ref,priority||'Medium']);
 await audit('ticket.created',q.rows[0].id);res.status(201).json({item:q.rows[0]});
}));
app.patch('/api/admin/tickets/:id',route(async(req,res)=>{
 const {status}=req.body||{};if(!['Open','Pending','Answered','Closed'].includes(status))return error(res,400,'Invalid ticket status');
 const q=await pool.query('UPDATE gameops_tickets SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
 if(!q.rowCount)return error(res,404,'Ticket not found');
 await audit('ticket.status_changed',req.params.id,{status});res.json({item:q.rows[0]});
}));
app.get('/api/admin/settings',route(async(req,res)=>{
 const q=await pool.query('SELECT key,value,version,updated_at FROM gameops_settings ORDER BY key');res.json({items:q.rows});
}));
app.put('/api/admin/settings/:key',route(async(req,res)=>{
 const key=req.params.key, value=req.body?.value;
 if(!/^[a-z0-9-]{2,60}$/.test(key)||!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>16000)return error(res,400,'Invalid settings object');
 const q=await pool.query("INSERT INTO gameops_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,version=gameops_settings.version+1,updated_at=now(),updated_by=EXCLUDED.updated_by RETURNING key,version,updated_at",[key,JSON.stringify(value),ADMIN_USERNAME]);
 await audit('settings.saved',key,{version:q.rows[0].version});res.json({item:q.rows[0]});
}));
app.get('/api/admin/system',route(async(req,res)=>{
 const db=await pool.query("SELECT current_database() AS database, current_setting('server_version') AS version,now() AS time");
 res.json({app:'Playground GameOps',appVersion:'0.4.0',dbConnected:true,postgresVersion:db.rows[0].version,serverTime:db.rows[0].time,auth:'session-cookie',eventIntegration:'HMAC SHA-256',walletSettlement:false,mfa:false});
}));
app.post('/api/v1/game-events',route(async(req,res)=>{
 if(!limit('ingest:'+(req.ip||'unknown'),200,60000))return error(res,429,'Rate limit');
 const ts=Number(req.get('X-Event-Timestamp'));
 const signature=req.get('X-Webhook-Signature')||'';
 if(!Number.isFinite(ts)||Math.abs(Date.now()-ts*1000)>300000)return error(res,401,'Expired or invalid timestamp');
 const raw=req.rawBody||Buffer.alloc(0);
 const expected='sha256='+crypto.createHmac('sha256',EVENT_SECRET).update(String(ts)+'.').update(raw).digest('hex');
 if(!secretEqual(signature,expected))return error(res,401,'Invalid event signature');
 const p=req.body||{};
 if(p.schema_version!==1||p.type!=='round.settled'||p.currency!=='DEMO_COIN'||
    !valid(p.event_id,120)||!valid(p.game_id,50)||!valid(p.round_id,120)||!valid(p.game_player_id,120)||
    !safeInt(p.stake_minor_units)||!safeInt(p.payout_minor_units)||!valid(p.occurred_at,50)||
    !Number.isFinite(Date.parse(p.occurred_at)))return error(res,400,'Invalid event payload');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const q=await client.query(
    'INSERT INTO gameops_events(event_id,game_id,round_id,player_ref,stake,payout,currency,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id',
    [p.event_id,p.game_id,p.round_id,p.game_player_id,p.stake_minor_units,p.payout_minor_units,p.currency,p.occurred_at]);
  if(!q.rowCount){await client.query('ROLLBACK');return res.status(200).json({accepted:false,duplicate:true});}
  await client.query('INSERT INTO gameops_players(game_id,player_ref,rounds) VALUES($1,$2,1) ON CONFLICT(game_id,player_ref) DO UPDATE SET rounds=gameops_players.rounds+1,last_seen=now()',[p.game_id,p.game_player_id]);
  await client.query('UPDATE gameops_games SET rounds=rounds+1 WHERE id=$1',[p.game_id]);
  await client.query('COMMIT');
  res.status(202).json({accepted:true,event_id:p.event_id});
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.use('/api',(req,res)=>error(res,404,'API endpoint not found'));
app.use((req,res)=>error(res,404,'Not found'));
app.use((err,req,res,next)=>{
 console.error('[gameops-error]',err.code||err.message);
 if(res.headersSent)return next(err);
 res.status(err.type==='entity.too.large'?413:500).json({error:'Request could not be completed'});
});
initDB().then(()=>{
 app.listen(PORT,'0.0.0.0',()=>console.log('Playground GameOps listening on '+PORT+' at '+iso()));
}).catch(e=>{console.error('Database startup failed:',e.message);process.exit(1);});
})();
