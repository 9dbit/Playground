'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const C = require('../engine/security-crypto');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('CP08 security against a real isolated PostgreSQL schema', { skip: !process.env.TEST_DATABASE_URL, timeout: 180000 }, async t => {
  const { Pool } = require('pg');
  const schema = 'cp08_test_' + crypto.randomBytes(8).toString('hex');
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await root.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const db = new Pool({ connectionString: url.toString() });
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const bootstrap = 'CP08 synthetic bootstrap password only';
  let ownerPassword = 'CP08 synthetic private password changed';
  let child, output = '';
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: url.toString(), PUBLIC_SITE_URL: base,
    ADMIN_USERNAME: 'qa_owner', ADMIN_PASSWORD: bootstrap,
    SESSION_SECRET: crypto.randomBytes(48).toString('hex'), GAME_EVENT_SECRET: crypto.randomBytes(48).toString('hex') };
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore','pipe','pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-6000); });
    for (let i=0;i<150;i++) {
      try { const r = await fetch(base + '/health'); if(r.ok) return; } catch {}
      if (child.exitCode !== null) throw Error('Test server failed: ' + output);
      await pause(100);
    }
    throw Error('Test server timeout: ' + output);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([exited,pause(11000)]); if(child.exitCode===null){child.kill('SIGKILL');await exited;}
  }
  t.after(async () => { await stop(); await db.end(); await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end(); });
  await start();
  async function request(endpoint, method='GET', body, session, overrides={}) {
    const headers={ Origin:base, ...(session ? {Cookie:session.cookie,'X-CSRF-Token':session.csrf} : {}), ...overrides };
    const options={method,headers,redirect:'manual'};
    if(body!==undefined){headers['Content-Type']='application/json';options.body=JSON.stringify(body)}
    const response=await fetch(base+endpoint,options),raw=await response.text();
    let data;try{data=JSON.parse(raw)}catch{data={text:raw}}
    const setCookie=response.headers.get('set-cookie');
    return {status:response.status,data,headers:response.headers,cookie:setCookie?setCookie.split(';')[0]:session?.cookie,csrf:data.csrf||session?.csrf};
  }
  const login=(username,password,code)=>request('/api/auth/login','POST',{username,password,...(code?{code}:{})});
  let owner, secret, recovery, initialSession, gameId;
  await t.test('anonymous access is denied; old signed cookies are invalid',async()=>{
    assert.equal((await request('/api/admin/summary')).status,401);
    assert.equal((await request('/engine')).status,302);
    assert.equal((await request('/api/auth/session','GET',undefined,undefined,{Cookie:'gameops_session=eyJ1IjoiYWRtaW4ifQ.legacy-signature'})).status,401);
    assert.equal((await login('qa_owner','wrong')).status,401);
  });
  await t.test('first login is forced into password and MFA setup',async()=>{
    owner=await login('qa_owner',bootstrap);assert.equal(owner.status,200);
    assert.equal(owner.data.role,'owner');assert.equal(owner.data.passwordChangeRequired,true);
    assert.equal(owner.data.setupRequired,true);initialSession={...owner};
    assert.match(owner.headers.get('set-cookie'),/HttpOnly/);assert.match(owner.headers.get('set-cookie'),/SameSite=Strict/);
    assert.equal((await request('/api/admin/summary','GET',undefined,owner)).status,403);
    assert.equal((await request('/engine','GET',undefined,owner)).headers.get('location'),'/security');
    const q=await db.query('SELECT password_hash FROM gameops_admin_accounts WHERE username=$1',['qa_owner']);
    assert.notEqual(q.rows[0].password_hash,bootstrap);assert.match(q.rows[0].password_hash,/^scrypt\$/);
  });
  await t.test('CSRF and cross-site mutations are blocked',async()=>{
    assert.equal((await request('/api/security/password','POST',{current_password:bootstrap,new_password:ownerPassword},owner,{'X-CSRF-Token':''})).status,403);
    assert.equal((await request('/api/security/password','POST',{current_password:bootstrap,new_password:ownerPassword},owner,{Origin:'https://wrong.example'})).status,403);
    assert.equal((await request('/api/auth/login','POST',{username:'qa_owner',password:bootstrap},undefined,{Origin:'https://wrong.example'})).status,403);
  });
  await t.test('password change revokes the previous session and supersedes the environment password',async()=>{
    const changed=await request('/api/security/password','POST',{current_password:bootstrap,new_password:ownerPassword},owner);
    assert.equal(changed.status,200);owner=changed;assert.equal(owner.data.passwordChangeRequired,false);
    assert.equal((await request('/api/auth/session','GET',undefined,initialSession)).status,401);
    assert.equal((await login('qa_owner',bootstrap)).status,401);
    assert.equal((await request('/api/admin/summary','GET',undefined,owner)).status,403);
  });
  await t.test('MFA secret is encrypted and enrollment must be confirmed',async()=>{
    const begin=await request('/api/security/mfa/begin','POST',{current_password:ownerPassword},owner);
    assert.equal(begin.status,200);secret=begin.data.secret;assert.match(secret,/^[A-Z2-7]{32}$/);
    const row=(await db.query("SELECT mfa_pending FROM gameops_admin_accounts WHERE username='qa_owner'")).rows[0];
    assert.equal(row.mfa_pending.includes(secret),false);
    assert.equal((await request('/api/security/mfa/confirm','POST',{code:'abcdef'},owner)).status,400);
    const before={...owner};const code=C.totp(secret,Math.floor(Date.now()/30000));
    const confirmed=await request('/api/security/mfa/confirm','POST',{code},owner);
    assert.equal(confirmed.status,200);owner=confirmed;recovery=confirmed.data.recoveryCodes;
    assert.equal(recovery.length,8);assert.equal(owner.data.setupRequired,false);
    assert.equal((await request('/api/auth/session','GET',undefined,before)).status,401);
    assert.equal((await request('/api/admin/summary','GET',undefined,owner)).status,200);
    assert.equal((await request('/engine','GET',undefined,owner)).status,200);
    const policy=(await request('/login')).headers.get('content-security-policy');
    assert.match(policy,/script-src 'self';/);assert.doesNotMatch(policy,/script-src[^;]*unsafe-inline/);
  });
  await t.test('login requires MFA; OTP and recovery code reuse are rejected',async()=>{
    const prompt=await login('qa_owner',ownerPassword);assert.equal(prompt.status,202);assert.equal(prompt.data.code,'MFA_REQUIRED');assert.equal(prompt.headers.get('set-cookie'),null);
    const last=(await db.query("SELECT mfa_last_step FROM gameops_admin_accounts WHERE username='qa_owner'")).rows[0].mfa_last_step;
    const replay=await login('qa_owner',ownerPassword,C.totp(secret,Number(last)));assert.equal(replay.status,401);
    const second=await login('qa_owner',ownerPassword,recovery[0]);assert.equal(second.status,200);
    assert.equal((await login('qa_owner',ownerPassword,recovery[0])).status,401);
    const revoked=await request('/api/security/sessions/revoke','POST',{session_id:second.data.sessionId},owner);assert.equal(revoked.status,200);
    assert.equal((await request('/api/auth/session','GET',undefined,second)).status,401);
    await request('/logout','GET',undefined,owner);
    assert.equal((await request('/api/auth/session','GET',undefined,owner)).status,200,'GET logout must not revoke');
  });
  const members={};
  await t.test('Owner creates three distinct roles; each account requires its own enrollment',async()=>{
    let i=1;
    for(const role of ['viewer','operator','support']){
      const username='qa_'+role,temp='Synthetic temporary '+role+' password',password='Synthetic replacement '+role+' password';
      const created=await request('/api/security/admins','POST',{username,display_name:'QA '+role,role,temporary_password:temp,current_password:ownerPassword,code:recovery[i++]},owner);
      assert.equal(created.status,201);assert.equal(created.data.item.setupRequired,true);
      let s=await login(username,temp);assert.equal(s.status,200);assert.equal((await request('/api/admin/summary','GET',undefined,s)).status,403);
      s=await request('/api/security/password','POST',{current_password:temp,new_password:password},s);assert.equal(s.status,200);
      const enrollment=await request('/api/security/mfa/begin','POST',{current_password:password},s);assert.equal(enrollment.status,200);
      s=await request('/api/security/mfa/confirm','POST',{code:C.totp(enrollment.data.secret,Math.floor(Date.now()/30000))},s);assert.equal(s.status,200);
      members[role]={...s,password,username,id:created.data.item.id};
    }
  });
  await t.test('all roles are enforced across both API families',async()=>{
    const viewer=members.viewer,support=members.support,operator=members.operator;
    assert.equal((await request('/api/admin/summary','GET',undefined,viewer)).status,200);
    assert.equal((await request('/api/admin/players','GET',undefined,viewer)).status,403);
    assert.equal((await request('/api/admin/deep/reports/logins','GET',undefined,viewer)).status,403);
    assert.equal((await request('/api/security/admins','GET',undefined,support)).status,403);
    const game={name:'QA Registry Only',slug:'qa-registry-only',code:'QA',platform:'Web / PWA'};
    assert.equal((await request('/api/admin/games','POST',game,support)).status,403);
    assert.equal((await request('/api/admin/deep/games/'+owner.data.id,'PUT',{},viewer)).status,403);
    const created=await request('/api/admin/games','POST',game,operator);assert.equal(created.status,201);gameId=created.data.item.id;
    assert.equal((await request('/api/admin/tickets','POST',{subject:'QA ticket',requester_ref:'qa_ref'},operator)).status,403);
    assert.equal((await request('/api/admin/tickets','POST',{subject:'QA ticket',requester_ref:'qa_ref'},support)).status,201);
    assert.equal((await request('/api/admin/deep/content/page','POST',{slug:'qa-test-page',title:'QA Only',body:'Local integration fixture',status:'draft'},operator)).status,201);
    assert.equal((await request('/api/admin/settings/general','PUT',{value:{}},operator)).status,403);
    assert.equal((await request('/api/admin/unknown-future-api','GET',undefined,owner)).status,403);
    assert.equal((await request('/api/admin/deep/games/'+gameId+'/rounds','GET',undefined,owner)).status,200);
  });
  await t.test('audit identifies the real actor and settings are filtered for non-owners',async()=>{
    const row=await db.query("SELECT actor FROM gameops_audit WHERE action='game.created' AND resource=$1",[gameId]);assert.equal(row.rows[0].actor,'qa_operator');
    const invalid=await request('/api/admin/settings/general','PUT',{value:{site_title:'QA',private_marker:'never-return-to-viewer'},expected_version:0},owner);
    assert.equal(invalid.status,400,'Unknown settings fields must be rejected');
    const general=await request('/api/admin/settings/general','PUT',{value:{site_title:'QA',register_bonus:7},expected_version:0},owner);
    assert.equal(general.status,200,JSON.stringify(general.data));
    const notification=await request('/api/admin/settings/notification','PUT',{value:{sender:'never-return-to-viewer'},expected_version:0},owner);
    assert.equal(notification.status,200,JSON.stringify(notification.data));
    const q=await request('/api/admin/settings','GET',undefined,members.viewer);assert.equal(q.status,200);
    assert.equal(JSON.stringify(q.data).includes('never-return-to-viewer'),false);
    assert.equal(q.data.items[0].value.site_title,'QA');
    assert.equal(q.data.items[0].value.register_bonus,undefined);
    assert.equal(q.data.items.some(item=>item.key==='notification'),false);
  });
  await t.test('role changes revoke target sessions; owner cannot disable self',async()=>{
    const changed=await request('/api/security/admins/'+members.operator.id,'PATCH',{role:'viewer',status:'active',current_password:ownerPassword,code:recovery[4]},owner);assert.equal(changed.status,200);
    assert.equal((await request('/api/auth/session','GET',undefined,members.operator)).status,401);
    assert.equal((await request('/api/security/admins/'+owner.data.id,'PATCH',{role:'viewer',status:'disabled'},owner)).status,409);
  });
  await t.test('password change with MFA revokes prior sessions',async()=>{
    const before={...owner},newPassword='A second synthetic owner password';
    const changed=await request('/api/security/password','POST',{current_password:ownerPassword,new_password:newPassword,code:recovery[5]},owner);
    assert.equal(changed.status,200);ownerPassword=newPassword;owner=changed;
    assert.equal((await request('/api/auth/session','GET',undefined,before)).status,401);
    const another=await login('qa_owner',ownerPassword,recovery[6]);assert.equal(another.status,200);
    const logout=await request('/api/auth/logout','POST',{},another);assert.equal(logout.status,200);
    assert.equal((await request('/api/auth/session','GET',undefined,another)).status,401);
  });
  await t.test('restart does not reset the DB password or account roles',async()=>{
    await stop();env.ADMIN_PASSWORD='Different synthetic bootstrap after restart';await start();
    assert.equal((await login('qa_owner',env.ADMIN_PASSWORD)).status,401);
    // Clear only a test account's accumulated login window to isolate this assertion.
    await db.query('DELETE FROM gameops_auth_buckets WHERE key=$1',[C.sha('login-user:qa_owner')]);
    const s=await login('qa_owner',ownerPassword,recovery[7]);assert.equal(s.status,200);owner=s;
    assert.equal((await request('/api/security/admins','GET',undefined,owner)).data.items.length,4);
  });
  await t.test('authenticator reset requires a factor and locks operational access until re-enrollment',async()=>{
    const old=await db.query("SELECT mfa_last_step FROM gameops_admin_accounts WHERE username='qa_owner'");
    const step=Math.max(Math.floor(Date.now()/30000),Number(old.rows[0].mfa_last_step)+1);
    const reset=await request('/api/security/mfa/reset','POST',{current_password:ownerPassword,code:C.totp(secret,step)},owner);assert.equal(reset.status,200);owner=reset;
    assert.equal(owner.data.setupRequired,true);assert.equal((await request('/api/admin/summary','GET',undefined,owner)).status,403);
    const begin=await request('/api/security/mfa/begin','POST',{current_password:ownerPassword},owner);assert.equal(begin.status,200);
    const confirm=await request('/api/security/mfa/confirm','POST',{code:C.totp(begin.data.secret,Math.floor(Date.now()/30000))},owner);assert.equal(confirm.status,200);owner=confirm;
    assert.equal((await request('/api/admin/summary','GET',undefined,owner)).status,200);
  });
  await t.test('idle expiration is enforced by database session lookup',async()=>{
    await db.query("UPDATE gameops_admin_sessions SET last_seen=now()-interval '31 minutes' WHERE id=$1",[members.viewer.data.sessionId]);
    assert.equal((await request('/api/auth/session','GET',undefined,members.viewer)).status,401);
  });
  await t.test('rate limiting persists across server restart',async()=>{
    for(let i=0;i<10;i++)assert.equal((await login('qa_unknown','synthetic wrong password')).status,401);
    assert.equal((await login('qa_unknown','synthetic wrong password')).status,429);
    await stop();await start();
    assert.equal((await login('qa_unknown','synthetic wrong password')).status,429);
  });
});
