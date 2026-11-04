'use strict';
const express = require('express');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const path = require('node:path');
const deep = require('./engine/deep-routes');
const { createSecurity } = require('./engine/security');
const { createBridge } = require('./engine/game-bridge');
const gameData = require('./engine/game-data');
const sourceWallet=require('./engine/source-wallet');
const virtualWallet=require('./engine/virtual-wallet');
const parity=require('./engine/parity');
const adminOps=require('./engine/admin-operations');
const {transaction,RequestError}=require('./engine/transaction');
const settingsSchema=require('./engine/settings-schema');
const {readPlayers}=require('./engine/player-list');
const publicContent=require('./engine/public-content');
const {createAgency}=require('./engine/agency');
const {mountOperations}=require('./engine/agency/operations');
const {createContent:createAgencyContent}=require('./engine/agency/content');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const PRODUCTION = process.env.NODE_ENV === 'production';
const VERSION = '0.17.1';
for (const [key, value] of Object.entries({ DATABASE_URL, SESSION_SECRET })) {
  if (!value) throw new Error('Missing required environment variable: ' + key);
}
if (SESSION_SECRET.length < 32) throw new Error('Signing secrets are too short');
const DATABASE_SCHEMA=process.env.DATABASE_SCHEMA||'';
if(DATABASE_SCHEMA&&!/^agency_sandbox_[a-z0-9_]{1,40}$/.test(DATABASE_SCHEMA))throw new Error('DATABASE_SCHEMA must name an isolated agency_sandbox_ namespace');
const pool = new Pool({ connectionString: DATABASE_URL,...(DATABASE_SCHEMA?{options:'-c search_path='+DATABASE_SCHEMA+',pg_catalog'}:{}), max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
const security = createSecurity({ pool, master: SESSION_SECRET,
  bootstrapUser: process.env.ADMIN_USERNAME, bootstrapPassword: process.env.ADMIN_PASSWORD,
  runtimeCredentialSync: process.env.ADMIN_CREDENTIALS_SYNC === 'true', runtimeCredentialRevision: process.env.ADMIN_CREDENTIALS_REVISION || '',
  publicOrigin: process.env.PUBLIC_SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : PRODUCTION ? 'https://playground-admin-production.up.railway.app' : 'http://localhost:' + PORT),
  production: PRODUCTION, publicDir: path.join(__dirname, 'public') });
const bridge = createBridge({ pool });
const wallet=sourceWallet.createWallet({pool});
const publicOrigin=process.env.PUBLIC_SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:'http://localhost:'+PORT);
const chatvice={origin:process.env.AGENCY_CHATVICE_ORIGIN||'',masterMerchant:process.env.AGENCY_CHATVICE_MASTER_MERCHANT||'',tenants:JSON.parse(process.env.AGENCY_CHATVICE_TENANT_MERCHANTS||'{}')};
if(chatvice.origin){if(new URL(chatvice.origin).protocol!=='https:')throw new Error('Chatvice requires HTTPS');chatvice.origin=new URL(chatvice.origin).origin;}
const agency=createAgency({pool,security,master:SESSION_SECRET,publicDir:path.join(__dirname,'public'),production:PRODUCTION,
 gameKeys:JSON.parse(process.env.AGENCY_GAME_KEYS||'[]'),simulationWorker:process.env.AGENCY_SIMULATION_WORKER==='true',chatvice});
const agencyContent=createAgencyContent({pool,agency,publicOrigin,chatvice});
const iso = () => new Date().toISOString();
const valid = (s, max = 120) => typeof s === 'string' && s.length > 0 && s.length <= max;
const safeInt = x => Number.isSafeInteger(x) && x >= 0 && x <= 1000000000000;
const validId = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const secretEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const route = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const error = (res, status, reason) => res.status(status).json({ error: reason });
async function audit(action, resource, details = {}, executor = pool) {
  await executor.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)', [security.currentActor(), action, resource, JSON.stringify(details)]);
}
// Webhook throughput limiter remains process-local. Login and reauthentication limits use PostgreSQL.
const hits = new Map();
function limit(key, max = 200, period = 60000) {
  const now = Date.now(), entry = hits.get(key);
  if (!entry && hits.size>=10000) return false;
  if (!entry || entry.until < now) { hits.set(key, { count: 1, until: now + period }); return true; }
  entry.count += 1; return entry.count <= max;
}
setInterval(() => { for (const [key, v] of hits) if (v.until < Date.now()) hits.delete(key); }, 60000).unref();
app.disable('x-powered-by'); app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if(chatvice.origin&&['/agents','/agency','/engine'].includes(req.path))res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' ${chatvice.origin}; style-src 'self' 'unsafe-inline'; img-src 'self' ${chatvice.origin} data:; connect-src 'self' ${chatvice.origin}; frame-src ${chatvice.origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json({ limit: '800kb', verify: (req, res, b) => { req.rawBody = Buffer.from(b); } }));
const ddl = `
CREATE TABLE IF NOT EXISTS gameops_games (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, code text NOT NULL DEFAULT '',
 platform text NOT NULL DEFAULT 'Web / PWA', version text NOT NULL DEFAULT '0.1.0',
 status text NOT NULL DEFAULT 'Maintenance' CHECK(status IN ('Active','Maintenance')),
 rounds bigint NOT NULL DEFAULT 0 CHECK(rounds>=0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_settings (
 key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb, version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NOT NULL DEFAULT 'system'
);
CREATE TABLE IF NOT EXISTS gameops_players (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), game_id uuid NOT NULL REFERENCES gameops_games(id), player_ref text NOT NULL,
 rounds bigint NOT NULL DEFAULT 0,last_seen timestamptz NOT NULL DEFAULT now(), UNIQUE(game_id,player_ref)
);
CREATE TABLE IF NOT EXISTS gameops_events (
 id bigserial PRIMARY KEY,event_id text NOT NULL UNIQUE,game_id uuid NOT NULL REFERENCES gameops_games(id),
 round_id text NOT NULL,player_ref text NOT NULL,stake bigint NOT NULL CHECK(stake>=0),payout bigint NOT NULL CHECK(payout>=0),
 currency text NOT NULL DEFAULT 'DEMO_COIN',occurred_at timestamptz NOT NULL,ingested_at timestamptz NOT NULL DEFAULT now(),UNIQUE(game_id,round_id)
);
CREATE TABLE IF NOT EXISTS gameops_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),player_ref text NOT NULL,amount bigint NOT NULL CHECK(amount>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),note text,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz
);
CREATE TABLE IF NOT EXISTS gameops_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),subject text NOT NULL,requester_ref text NOT NULL,
 priority text NOT NULL DEFAULT 'Medium',status text NOT NULL DEFAULT 'Open',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_audit (
 id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,resource text NOT NULL,details jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gameops_events_time_idx ON gameops_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS gameops_events_game_time_idx ON gameops_events(game_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS gameops_audit_time_idx ON gameops_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS gameops_players_last_seen_idx ON gameops_players(last_seen DESC);
`;
async function initDB() {
  if(DATABASE_SCHEMA)await pool.query('CREATE SCHEMA IF NOT EXISTS '+DATABASE_SCHEMA);
  await pool.query(ddl); await deep.ensureSchema(pool); await virtualWallet.ensureSchema(pool); await security.init(); await adminOps.ensureSchema(pool);
  for (const [name, slug, code] of [['Skygate 5000','skygate-5000','SK'],['UNO LUCK','uno-luck','UN'],['Mahjong Wild','mahjong-wild','MW']]) {
    await pool.query('INSERT INTO gameops_games(name,slug,code) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING', [name, slug, code]);
  }
  await bridge.init(); await wallet.init();
  await agency.init();
  const conflicts=await publicContent.inspectConflicts(pool);
  console.log('[cms-public-url] canonical namespaces active; ambiguous legacy slugs:',conflicts);
}
app.get('/health', route(async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', service: 'playground-gameops', version: VERSION, db: 'connected', time: iso() }); }
  catch { res.status(503).json({ status: 'degraded', db: 'unavailable' }); }
}));
app.use(agencyContent.domainRouter);
security.mount(app);
app.get('/', (req, res) => res.redirect('/engine'));
app.get('/engine', security.protectedPage('control.html'));
app.get('/integrations', security.protectedPage('bridge.html'));
app.get('/data', security.protectedPage('data.html'));
app.get('/wallet',security.protectedPage('wallet.html'));
app.get('/engine-v1', security.protectedPage('engine.html'));
app.get('/preview', security.protectedPage('preview.html'));
for (const filename of ['control.js','engine.js','bridge-ui.js','bridge-nav.js','data-ui.js','data-nav.js','wallet-ui.js']) app.get('/assets/' + filename, security.authenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', filename)));
for (const filename of ['control.css','parity.css','admin-ops.css','engine.css','bridge.css','data.css']) app.get('/assets/' + filename, (req, res) => res.sendFile(path.join(__dirname, 'public', filename)));
app.use('/api/admin', ...security.adminAuth);
app.get('/api/admin/summary', route(async (req, res) => {
  const [g,p,r,ev] = await Promise.all([
    pool.query('SELECT count(*)::int AS count,count(*) FILTER (WHERE status=$1)::int AS active FROM gameops_games', ['Active']),
    pool.query('SELECT count(*)::int AS count FROM gameops_players'),
    pool.query('SELECT count(*)::int AS count FROM gameops_requests WHERE status=$1', ['pending']),
    pool.query('SELECT count(*)::int AS rounds,COALESCE(sum(stake),0)::text AS stake,COALESCE(sum(payout),0)::text AS payout FROM gameops_events')
  ]);
  const e=ev.rows[0]; res.json({ gameCount:g.rows[0].count,activeGames:g.rows[0].active,players:p.rows[0].count,pendingRequests:r.rows[0].count,
    rounds:e.rounds,stake:e.stake,payout:e.payout,margin:(BigInt(e.stake)-BigInt(e.payout)).toString(),currency:'DEMO_COIN',sample:false,asOf:iso() });
}));
app.get('/api/admin/games', route(async (req,res) => {
 const q=await pool.query('SELECT id,name,slug,code,platform,version,status,rounds::text AS rounds,created_at FROM gameops_games ORDER BY created_at,id'); res.json({items:q.rows});
}));
app.post('/api/admin/games',route(async(req,res)=>{
 const {name,slug,code,platform}=req.body||{};
 if(!valid(name,80)||!name.trim()||!valid(slug,60)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||!valid(code,6)||!valid(platform||'Web / PWA',60))return error(res,400,'Invalid game fields');
 const item=await transaction(pool,async db=>{
  const q=await db.query('INSERT INTO gameops_games(name,slug,code,platform) VALUES($1,$2,$3,$4) ON CONFLICT(slug) DO NOTHING RETURNING *',[name.trim(),slug,code,platform||'Web / PWA']);
  if(!q.rowCount)throw new RequestError(409,'Game slug exists');
  await audit('game.created',q.rows[0].id,{name,slug},db);return q.rows[0];
 });
 res.status(201).json({item});
}));
app.patch('/api/admin/games/:id',route(async(req,res)=>{
 const {status}=req.body||{};
 if(!validId(req.params.id)||!['Active','Maintenance'].includes(status))return error(res,400,'Invalid game status or id');
 const item=await transaction(pool,async db=>{
  const q=await db.query('UPDATE gameops_games SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Game not found');
  await audit('game.status_changed',req.params.id,{status},db);return q.rows[0];
 });
 res.json({item,notice:'Catalog metadata only; external game engines are unchanged'});
}));

app.get('/api/admin/players',route(async(req,res)=>{
 res.json(await readPlayers(pool,req.query));
}));
app.get('/api/admin/rounds',route(async(req,res)=>{
 const q=await pool.query('SELECT e.event_id,e.round_id,g.name AS game,e.player_ref,e.stake::text,e.payout::text,e.currency,e.occurred_at FROM gameops_events e JOIN gameops_games g ON g.id=e.game_id ORDER BY e.occurred_at DESC LIMIT 200');res.json({items:q.rows});
}));
app.get('/api/admin/audit',route(async(req,res)=>{
 const q=await pool.query('SELECT id::text,actor,action,resource,details,created_at FROM gameops_audit ORDER BY id DESC LIMIT 200');res.json({items:q.rows});
}));
app.get('/api/admin/requests',route(async(req,res)=>{
 const q=await pool.query('SELECT id,player_ref,amount::text,status,note,created_at,reviewed_at FROM gameops_requests ORDER BY created_at DESC LIMIT 200');res.json({items:q.rows,notice:'Approval is metadata only; no wallet credit or settlement is performed'});
}));
app.patch('/api/admin/requests/:id',route(async(req,res)=>{
 const {status,note}=req.body||{};
 if(!validId(req.params.id)||!['approved','rejected'].includes(status)||(note!=null&&!valid(note,500)))return error(res,400,'Invalid decision');
 const item=await transaction(pool,async db=>{
  const q=await db.query("UPDATE gameops_requests SET status=$1,note=$2,reviewed_at=now() WHERE id=$3 AND status='pending' RETURNING *",[status,note||null,req.params.id]);
  if(!q.rowCount)throw new RequestError(409,'Not found or already reviewed');
  await audit('request.reviewed',req.params.id,{status},db);return q.rows[0];
 });res.json({item,settled:false});
}));
app.get('/api/admin/tickets',route(async(req,res)=>{const q=await pool.query('SELECT * FROM gameops_tickets ORDER BY created_at DESC LIMIT 200');res.json({items:q.rows});}));
app.post('/api/admin/tickets',route(async(req,res)=>{
 const {subject,requester_ref,priority}=req.body||{};
 if(!valid(subject,200)||!subject.trim()||!valid(requester_ref,120)||!['Low','Medium','High'].includes(priority||'Medium'))return error(res,400,'Invalid ticket fields');
 const item=await transaction(pool,async db=>{
  const q=await db.query('INSERT INTO gameops_tickets(subject,requester_ref,priority) VALUES($1,$2,$3) RETURNING *',[subject.trim(),requester_ref,priority||'Medium']);
  await audit('ticket.created',q.rows[0].id,{},db);return q.rows[0];
 });res.status(201).json({item});
}));
app.patch('/api/admin/tickets/:id',route(async(req,res)=>{
 const {status}=req.body||{};
 if(!validId(req.params.id)||!['Open','Pending','Answered','Closed'].includes(status))return error(res,400,'Invalid ticket status');
 const item=await transaction(pool,async db=>{
  const q=await db.query('UPDATE gameops_tickets SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[status,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Ticket not found');
  await audit('ticket.status_changed',req.params.id,{status},db);return q.rows[0];
 });res.json({item});
}));
app.get('/api/admin/settings',route(async(req,res)=>{
 const q=await pool.query('SELECT key,value,version,updated_at FROM gameops_settings ORDER BY key');
 if(req.auth.role==='owner')return res.json({items:q.rows.map(x=>({...x,validationErrors:settingsSchema.errorsFor(x.key,x.value)}))});
 const general=q.rows.find(x=>x.key==='general');
 const allowed=['site_title','base_color','secondary_color','currency','currency_symbol','currency_format','timezone','per_page'];
 res.json({items:general?[{...general,value:Object.fromEntries(Object.entries(general.value).filter(([key])=>allowed.includes(key)))}]:[]});
}));
app.put('/api/admin/settings/:key',route(async(req,res)=>{
 const key=req.params.key,value=settingsSchema.validate(key,req.body?.value);
 const expected=settingsSchema.expectedVersion(req.body?.expected_version);
 const item=await transaction(pool,async db=>{
  let q;
  if(expected===0)q=await db.query('INSERT INTO gameops_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING RETURNING key,version,updated_at',[key,JSON.stringify(value),req.auth.username]);
  else q=await db.query('UPDATE gameops_settings SET value=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE key=$1 AND version=$4 RETURNING key,version,updated_at',[key,JSON.stringify(value),req.auth.username,expected]);
  if(!q.rowCount)throw new RequestError(409,'Settings changed in another session. Your edits were not saved; reload the latest version.','SETTINGS_VERSION_CONFLICT');
  await audit('settings.saved',key,{version:q.rows[0].version},db);return q.rows[0];
 });
 res.set('ETag','"'+item.version+'"').json({item});
}));
app.get('/api/admin/system',route(async(req,res)=>{
 const db=await pool.query("SELECT current_setting('server_version') AS version,now() AS time");
 res.json({app:'Playground GameOps',appVersion:VERSION,dbConnected:true,postgresVersion:db.rows[0].version,serverTime:db.rows[0].time,auth:'database-sessions',eventIntegration:'HMAC SHA-256',walletSettlement:false,mfa:req.auth.mfa_enabled,rbac:true});
}));
app.get('/api/admin/deep/system/:name',route(async(req,res)=>{
 if(!['server','application','cache','update','cron','security'].includes(req.params.name))return error(res,404,'Unknown module');
 res.json({name:req.params.name,readOnly:true,asOf:iso(),appVersion:VERSION,mfaEnabled:req.auth.mfa_enabled,mfaRequired:true,rbacEnabled:true,role:req.auth.role,gameControlConnected:false,message:'Security Center is active. Infrastructure maintenance and game adapters remain disconnected.'});
}));
// CP08 shared-key ingestion is retired. New integrations have immutable per-game scopes.
app.post('/api/v1/game-events',(req,res)=>res.status(410).json({error:'LEGACY_INGESTION_RETIRED',endpoint:'/api/v2/game-bridge'}));
app.use('/api/v3/wallet-sync',(req,res,next)=>{if(!limit('wallet:'+(req.ip||'unknown'),120))return res.status(429).json({error:'RATE_LIMITED'});next();});
app.use('/api/v2/game-bridge',(req,res,next)=>{if(!limit('bridge:'+(req.ip||'unknown'),240))return res.status(429).json({error:'RATE_LIMITED'});next();});
bridge.mount(app);
gameData.mount(app,{pool});
wallet.mount(app);
deep.mount(app,{pool,audit});
virtualWallet.mount(app,{pool,currentActor:security.currentActor});
parity.mount(app,{pool});
adminOps.mount(app,{pool});
publicContent.mount(app,{pool});
agency.mount(app);
agencyContent.mount(app);
mountOperations(app,{pool,agency,chatvice});
app.use('/api',(req,res)=>error(res,404,'API endpoint not found'));
app.use((req,res)=>error(res,404,'Not found'));
app.use(security.errorHandler);
app.use((err,req,res,next)=>{
 console.error('[gameops-error]',err.code||err.type||'REQUEST_FAILED');
 if(res.headersSent)return next(err);
 if(err instanceof RequestError)return res.status(err.status).json({error:err.message,code:err.code});
 const status=err.type==='entity.too.large'?413:err.type==='entity.parse.failed'||err.code==='22P02'?400:err.code==='23505'?409:500;
 res.status(status).json({error:status===400?'Invalid request':status===409?'Record conflicts with existing data':'Request could not be completed'});
});
if(require.main===module)initDB().then(()=>{
 const server=app.listen(PORT,'0.0.0.0',()=>console.log('Playground GameOps '+VERSION+' listening on '+PORT+' at '+iso()));
 const stopScheduler=adminOps.startScheduler(pool,{onError:e=>console.error('[maintenance-job]',e.code||e.message)});
 const stopAgency=agency.startWorker();
 let publishing=false;
 const publisher=setInterval(async()=>{if(publishing)return;publishing=true;try{await agencyContent.tick()}catch(e){console.error('[agency-publisher]',e.code||e.message)}finally{publishing=false}},30000);publisher.unref();
 const stop=()=>{stopScheduler();stopAgency();clearInterval(publisher);server.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}).catch(e=>{console.error('Database startup failed:',e.code||e.message);process.exit(1);});
module.exports={app,pool,initDB,agency,agencyContent,security};
