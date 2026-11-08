'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const express=require('express');
const {createAuth}=require('../engine/agency/auth');
const C=require('../engine/security-crypto');
test('Account protection with real HTTP and isolated PostgreSQL', {timeout:120000}, async t=>{
 const pool=new(require('./helpers/pglite-pool.cjs').Pool)();
 await pool.query(`CREATE TABLE gameops_auth_buckets(key text PRIMARY KEY,hits integer,expires_at timestamptz);
 CREATE TABLE agency_tenants(id uuid PRIMARY KEY,slug text,name text,environment text,status text,policy jsonb DEFAULT '{}');
 CREATE TABLE agency_staff(id uuid PRIMARY KEY,tenant_id uuid,username text,display_name text,password_hash text,role text,status text DEFAULT 'active',auth_version integer DEFAULT 1,mfa_enabled boolean DEFAULT false,mfa_secret text,mfa_last_step bigint DEFAULT -1,ip_allowlist jsonb DEFAULT '[]');
 CREATE TABLE agency_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,staff_id uuid,player_id uuid,token_hash text,auth_version integer,ip text,user_agent text,expires_at timestamptz);
 CREATE TABLE agency_audit(id bigserial PRIMARY KEY,tenant_id uuid,actor text,action text,resource text,details jsonb,created_at timestamptz DEFAULT now());`);
 const tenant=crypto.randomUUID(),staff=crypto.randomUUID(),password=crypto.randomBytes(24).toString('base64url');
 await pool.query("INSERT INTO agency_tenants VALUES($1,'qa','QA','sandbox','active','{}')",[tenant]);
 await pool.query("INSERT INTO agency_staff(id,tenant_id,username,display_name,password_hash,role) VALUES($1,$2,'qa@example.test','QA',$3,'owner')",[staff,tenant,await C.passwordHash(password)]);
 const auth=createAuth({pool,master:crypto.randomBytes(48).toString('hex')});await auth.init();
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{if(req.get('X-QA-Foreign-Site'))req.agencySite={id:'22222222-2222-4222-8222-222222222222'};next();});auth.mount(app);
 app.use((e,_req,res,_next)=>res.status(e.status||500).json({error:e.message,code:e.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await pool.end();});
 const base='http://127.0.0.1:'+server.address().port;
 async function req(url,method='GET',body,session,extra={}){const r=await fetch(base+url,{method,headers:{Origin:base,...extra,...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.data.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||session?.cookie};}
 const login=(username,p=password,slug='qa',kind='agency')=>req('/api/'+kind+'/auth/login','POST',{tenant:slug,username,password:p});
 await t.test('case and whitespace variants share a login budget; tenants and actor types do not collide',async()=>{
  for(let i=0;i<30;i++)assert.equal((await login(i%2?'  UNKNOWN@EXAMPLE.TEST  ':'unknown@example.test',null)).status,401);
  assert.equal((await login('Unknown@Example.Test',null)).status,429);
  assert.equal((await login('unknown@example.test',null,'other-tenant')).status,401);
  assert.equal((await login('unknown@example.test',null,'other-tenant','player')).status,401);
 });
 await t.test('IP-wide budget blocks username rotation before password work',async()=>{
  await pool.query("UPDATE gameops_auth_buckets SET hits=180 WHERE key=$1",[C.sha('agency:login-ip:127.0.0.1')]);
  assert.equal((await login('new-identity@example.test',null)).status,429);
  await pool.query('DELETE FROM gameops_auth_buckets');
 });
 let session;
 await t.test('normalized login produces scoped session and audit without storing credentials',async()=>{
  session=await login(' QA@EXAMPLE.TEST ');assert.equal(session.status,200);assert.equal(session.data.tenant_id,tenant);
  const me=await req('/api/agency/me','GET',undefined,session);assert.equal(me.status,200);assert.equal(me.data.id,staff);
  const audit=(await pool.query("SELECT * FROM agency_audit WHERE action='auth.login'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].tenant_id,tenant);assert.ok(!JSON.stringify(audit).includes(password));
 });
 await t.test('a valid session cannot read a different website tenant',async()=>{
  assert.equal((await req('/api/agency/me','GET',undefined,session,{'X-QA-Foreign-Site':'yes'})).status,403);
 });
 await t.test('closed workspace invalidates an existing session and refuses new login',async()=>{
  await pool.query("UPDATE agency_tenants SET status='closed'");
  assert.equal((await req('/api/agency/me','GET',undefined,session)).status,401);
  assert.equal((await login('qa@example.test')).status,401);
  await pool.query("UPDATE agency_tenants SET status='active'");
 });
 await t.test('logout and audit commit together; a failed audit cannot silently revoke the session',async()=>{
  await pool.query("ALTER TABLE agency_audit ADD CONSTRAINT fail_logout CHECK(action<>'auth.logout')");
  assert.equal((await req('/api/agency/auth/logout','POST',{},session)).status,500);
  assert.equal((await req('/api/agency/me','GET',undefined,session)).status,200);
  await pool.query('ALTER TABLE agency_audit DROP CONSTRAINT fail_logout');
  assert.equal((await req('/api/agency/auth/logout','POST',{},session)).status,200);
  assert.equal((await req('/api/agency/me','GET',undefined,session)).status,401);
  const audit=(await pool.query("SELECT * FROM agency_audit WHERE action='auth.logout'")).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].tenant_id,tenant);assert.equal(audit[0].actor,staff);
 });
});
