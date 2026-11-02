'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {Pool}=require('pg');
const ops=require('../engine/admin-operations');
const {canAccess}=require('../engine/security-policy');

test('dashboard operations role permissions and activity scoping',()=>{
 assert.equal(canAccess('viewer','GET','/ops/search'),true);
 assert.equal(canAccess('viewer','GET','/ops/notifications'),true);
 assert.equal(canAccess('viewer','POST','/ops/cron/run'),false);
 assert.equal(canAccess('support','POST','/ops/cron/run'),false);
 assert.equal(canAccess('owner','POST','/ops/cron/run'),true);
 assert.equal(canAccess('operator','PUT','/ops/profile'),true);
 assert.equal(canAccess('viewer','POST','/ops/notifications/read-all'),true);
 assert.equal(canAccess('viewer','GET','/ops/admins'),false);
 assert.equal(ops.visibleActions('viewer').includes('ticket.created'),false);
 assert.equal(ops.visibleActions('owner').includes('game.created'),true);
 assert.equal(ops.visibleActions('owner').includes('security.password.changed'),false);
});

test('live Dashboard operations with isolated PostgreSQL persistence',{skip:!process.env.TEST_DATABASE_URL,timeout:120000},async t=>{
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const schema='cp11_admin_'+crypto.randomBytes(8).toString('hex');
 await admin.query('CREATE SCHEMA '+schema);
 const url=new URL(process.env.TEST_DATABASE_URL);
 url.searchParams.set('options','-c search_path='+schema+',public');
 const db=new Pool({connectionString:url.toString()});
 let server;
 t.after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  await db.end();
  await admin.query('DROP SCHEMA '+schema+' CASCADE');
  await admin.end();
 });
 const ddl=[
  "CREATE TABLE gameops_admin_accounts(id uuid PRIMARY KEY,username text,display_name text,role text,status text,mfa_enabled boolean)",
  "CREATE TABLE gameops_audit(id bigserial PRIMARY KEY,actor text,action text,resource text,details jsonb DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now())",
  "CREATE TABLE gameops_settings(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())",
  "CREATE TABLE gameops_revoked_sessions(nonce text PRIMARY KEY,expires_at timestamptz NOT NULL)",
  "CREATE TABLE gameops_admin_sessions(id uuid PRIMARY KEY,admin_id uuid,expires_at timestamptz NOT NULL)",
  "CREATE TABLE gameops_games(id uuid PRIMARY KEY,name text,slug text,status text)",
  "CREATE TABLE gameops_players(id uuid PRIMARY KEY,game_id uuid,player_ref text,last_seen timestamptz DEFAULT now())",
  "CREATE TABLE gameops_tickets(id uuid PRIMARY KEY,subject text,status text,created_at timestamptz DEFAULT now())",
  "CREATE TABLE gameops_content(id uuid PRIMARY KEY,kind text,title text,slug text,updated_at timestamptz DEFAULT now())"
 ];
 for(const sql of ddl)await db.query(sql);
 await ops.ensureSchema(db);
 await ops.ensureSchema(db);
 const alice='10000000-0000-4000-8000-000000000001';
 const bob='10000000-0000-4000-8000-000000000002';
 const game='20000000-0000-4000-8000-000000000001';
 const player='30000000-0000-4000-8000-000000000001';
 const ticket='40000000-0000-4000-8000-000000000001';
 const content='50000000-0000-4000-8000-000000000001';
 await db.query("INSERT INTO gameops_admin_accounts(id,username,display_name,role,status,mfa_enabled) VALUES($1,'alice','Alice','owner','active',true),($2,'bob','Bob','viewer','active',true)",[alice,bob]);
 await db.query("INSERT INTO gameops_games(id,name,slug,status) VALUES($1,'Skygate 5000','skygate-5000','Active')",[game]);
 await db.query("INSERT INTO gameops_players(id,game_id,player_ref) VALUES($1,$2,'demo-hero-1')",[player,game]);
 await db.query("INSERT INTO gameops_tickets(id,subject,status) VALUES($1,'Test QA support request','Open')",[ticket]);
 await db.query("INSERT INTO gameops_content(id,kind,title,slug) VALUES($1,'page','Test QA Article','qa-article')",[content]);
 const ins=await db.query("INSERT INTO gameops_audit(actor,action,resource) VALUES('alice','game.created',$1),('alice','ticket.created',$2),('alice','security.password.changed',$3) RETURNING id::text,action",[game,ticket,alice]);
 const gameId=ins.rows.find(x=>x.action==='game.created').id;
 const ticketId=ins.rows.find(x=>x.action==='ticket.created').id;
 const app=express();app.use(express.json());
 app.use((req,res,next)=>{const isBob=req.get('X-QA-Actor')==='bob';req.auth={id:isBob?bob:alice,username:isBob?'bob':'alice',role:isBob?'viewer':'owner'};next()});
 ops.mount(app,{pool:db});
 server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv))});
 const base='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body,actor='alice'){
  const res=await fetch(base+path,{method,headers:{'X-QA-Actor':actor,'Content-Type':'application/json'},
   ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:res.status,data:await res.json()};
 }
 const prefix='/api/admin/ops/';
 const invalid=await request(prefix+'search?q=x');
 assert.equal(invalid.status,400);
 const gs=await request(prefix+'search?q=Sky');
 assert.equal(gs.status,200);assert.ok(gs.data.items.some(x=>x.type==='Game'&&x.route==='game/'+game));
 const pls=await request(prefix+'search?q=demo');
 assert.ok(pls.data.items.some(x=>x.type==='Player'&&x.route==='player/'+player));
 const tks=await request(prefix+'search?q=support');
 assert.ok(tks.data.items.some(x=>x.type==='Ticket'&&x.route==='ticket/'+ticket));
 const pages=await request(prefix+'search?q=article');
 assert.ok(pages.data.items.some(x=>x.type==='Content'&&x.route==='content-edit/page/'+content));
 const bobSearch=await request(prefix+'search?q=demo','GET',undefined,'bob');
 assert.equal(bobSearch.data.items.length,0,'Viewer must not see player search matches');
 const pct=await request(prefix+'search?q=%25_');
 assert.equal(pct.data.items.length,0,'Search cannot treat percent as a SQL wildcard');
 const a0=await request(prefix+'notifications');
 assert.equal(a0.data.unread,2);
 assert.equal(a0.data.items.length,2,'Sensitive security events must not be visible in dashboard notification feed');
 const bobN=await request(prefix+'notifications','GET',undefined,'bob');
 assert.equal(bobN.data.unread,1,'Viewer only sees game updates');
 assert.equal((await request(prefix+'notifications/'+ticketId+'/read','POST',{},'bob')).status,404);
 assert.equal((await request(prefix+'notifications/'+gameId+'/read','POST',{})).status,200);
 const a1=await request(prefix+'notifications');
 assert.equal(a1.data.unread,1);
 const all=await request(prefix+'notifications/read-all','POST',{});
 assert.equal(all.data.marked,1);
 const a2=await request(prefix+'notifications');
 assert.equal(a2.data.unread,0);
 const stillBob=await request(prefix+'notifications','GET',undefined,'bob');
 assert.equal(stillBob.data.unread,1,'Read state must be scoped to individual administrator');
 const p0=await request(prefix+'profile');
 assert.equal(p0.data.item.displayName,'Alice');
 assert.equal(p0.data.item.username,'alice');
 const notValid=await request(prefix+'profile','PUT',{displayName:'<bad>'});
 assert.equal(notValid.status,400);
 const profile=await request(prefix+'profile','PUT',{displayName:'Alice QA'});
 assert.equal(profile.status,200);
 const p1=await request(prefix+'profile');
 assert.equal(p1.data.item.displayName,'Alice QA');
 await db.query("INSERT INTO gameops_revoked_sessions(nonce,expires_at) VALUES('expired',now()-interval '2 days'),('active',now()+interval '1 day')");
 await db.query("INSERT INTO gameops_admin_sessions(id,admin_id,expires_at) VALUES($1,$2,now()-interval '2 days'),($3,$2,now()+interval '1 day')",
  [crypto.randomUUID(),alice,crypto.randomUUID()]);
 const cfg=await request(prefix+'cron');
 assert.equal(cfg.data.enabled,false);
 const manual=await request(prefix+'cron/run','POST',{});
 assert.equal(manual.status,200);assert.equal(manual.data.run.cleaned_revocations,1);assert.equal(manual.data.run.cleaned_sessions,1);
 const safe=await db.query("SELECT count(*)::int AS n FROM gameops_admin_sessions WHERE expires_at>now()");
 assert.equal(safe.rows[0].n,1,'Must not delete active administrator session');
 const stillLive=await db.query("SELECT count(*)::int AS n FROM gameops_revoked_sessions WHERE nonce='active'");
 assert.equal(stillLive.rows[0].n,1,'Must not delete active revoked token markers');
 const runAgain=await request(prefix+'cron/run','POST',{});
 assert.equal(runAgain.data.run.cleaned_sessions,0);
 const disabled=await ops.runMaintenance(db,{actor:'scheduler'});
 assert.equal(disabled.status,'disabled');
 await db.query("INSERT INTO gameops_settings(key,value) VALUES('cron',$1::jsonb)",[JSON.stringify({enabled:true,interval_minutes:10})]);
 const due=await ops.runMaintenance(db,{actor:'scheduler'});
 assert.equal(due.status,'not_due','Auto-cleanup should respect the configured interval');
 const history=await request(prefix+'cron');
 assert.equal(history.data.history.length,2);
 const securityAudit=await db.query("SELECT count(*)::int AS n FROM gameops_audit WHERE action='admin.profile.updated' OR action='maintenance.cleanup.completed'");
 assert.equal(securityAudit.rows[0].n,3);
});
