'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { createSecurity } = require('../engine/security');
const { canAccess } = require('../engine/security-policy');
const support = require('../engine/ai-support');

test('AI support frame permission is limited to authenticated dashboard pages', () => {
  for (const route of ['/engine','/integrations','/data','/wallet']) {
    const csp = support.contentSecurityPolicy(route);
    assert.match(csp, /frame-src https:\/\/chatvice\.app$/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /connect-src 'self';/);
    assert.match(csp, /frame-ancestors 'none';/);
    assert.doesNotMatch(csp, /unsafe-eval|\*/);
  }
  for (const route of ['/','/login','/security','/api/admin/ai-support','/page/test']) {
    assert.match(support.contentSecurityPolicy(route), /frame-src 'none'$/);
  }
});

test('AI config is read-only and restricted to known admin roles', () => {
  for (const role of ['owner','operator','support','viewer']) {
    assert.equal(canAccess(role,'GET','/ai-support'),true);
    for (const verb of ['POST','PATCH','DELETE','PUT']) assert.equal(canAccess(role,verb,'/ai-support'),false);
  }
  for (const role of ['player','agent','',null]) assert.equal(canAccess(role,'GET','/ai-support'),false);
});

test('actual auth middleware rejects guest/incomplete sessions and returns only public embed config', async t => {
  let account = null;
  const pool = { query: async sql => {
    if (sql.startsWith('SELECT a.*')) return {rowCount: account ? 1 : 0, rows: account ? [account] : []};
    if (sql.startsWith('UPDATE gameops_admin_sessions')) return {rowCount:1,rows:[]};
    throw Error('Unexpected SQL in test');
  }};
  const security = createSecurity({pool,master:'synthetic test master '.repeat(4),publicOrigin:'http://localhost',publicDir:path.join(__dirname,'../public')});
  const app = express();
  app.get('/engine',security.protectedPage('control.html'));
  app.get('/assets/ai-support.js',security.authenticated,(req,res)=>res.sendFile(path.join(__dirname,'../public/ai-support.js')));
  app.use('/api/admin',...security.adminAuth);
  app.get('/api/admin/ai-support',support.configHandler);
  app.use(security.errorHandler);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  const cookie = 'gameops_session='+'a'.repeat(43);
  const get = (route,loggedIn=false)=>fetch(base+route,{redirect:'manual',headers:loggedIn?{Cookie:cookie}:{}});
  assert.equal((await get('/api/admin/ai-support')).status,401);
  assert.equal((await get('/assets/ai-support.js')).status,401);
  assert.equal((await get('/engine')).headers.get('location'),'/login');
  account={id:'synthetic',username:'test-admin',role:'viewer',status:'active',auth_version:1,session_version:1,session_id:'synthetic-session',must_change_password:true,mfa_enabled:false,mfa_verified:false,expires_at:new Date(Date.now()+3600000),last_seen:new Date()};
  assert.equal((await get('/api/admin/ai-support',true)).status,403);
  assert.equal((await get('/engine',true)).headers.get('location'),'/security');
  account={...account,must_change_password:false,mfa_enabled:true,mfa_verified:true};
  const response=await get('/api/admin/ai-support',true),config=await response.json();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(config).sort(),['enabled','url','validUntil']);
  assert.equal(config.url,support.WIDGET_URL);
  assert.ok(config.validUntil>Date.now()&&config.validUntil<=Date.now()+30*60000);
  assert.equal((await get('/engine',true)).status,200);
  account={...account,role:'player'};
  assert.equal((await get('/api/admin/ai-support',true)).status,403);
  account={...account,role:'viewer',expires_at:new Date(0)};
  assert.equal((await get('/api/admin/ai-support',true)).status,401);
});
