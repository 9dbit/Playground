'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

test('development access uses isolated, revocable PostgreSQL sessions', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 90000
}, async t => {
  const express = require('express');
  const { Pool } = require('pg');
  const { createSecurity } = require('../engine/security');
  const schema = 'development_test_' + crypto.randomBytes(8).toString('hex');
  const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await root.query('CREATE SCHEMA ' + schema);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const db = new Pool({ connectionString: url.toString() });
  const master = crypto.randomBytes(48).toString('hex');
  const key = crypto.randomBytes(32).toString('base64url');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const deadline = new Date(Date.now() + 14 * 86400000).toISOString();
  const enabled = { enabled: true, keyHash: hash(key), expiresAt: deadline };
  const bootstrapPassword = 'Synthetic development QA owner bootstrap';
  let server, base, development, owner;

  async function stop() {
    if (!server) return;
    const current = server; server = null;
    await new Promise((resolve, reject) => {
      current.close(error => error ? reject(error) : resolve());
      current.closeAllConnections();
    });
  }
  t.after(async () => {
    await stop();
    await db.end();
    try { await root.query('DROP SCHEMA ' + schema + ' CASCADE'); }
    finally { await root.end(); }
  });
  await db.query(`
    CREATE TABLE gameops_audit (
      id bigserial PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
      resource text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE gameops_login_history (
      id bigserial PRIMARY KEY, username text NOT NULL, success boolean NOT NULL,
      ip text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  async function start(developmentAccess) {
    await stop();
    const app = express();
    app.use(express.json());
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    const security = createSecurity({
      pool: db, master, bootstrapUser: 'qa_owner', bootstrapPassword,
      publicOrigin: base, production: false,
      publicDir: path.join(__dirname, '../public'), developmentAccess
    });
    await security.init();
    security.mount(app);
    app.get('/engine', security.protectedPage('control.html'));
    app.get('/engine-v1', security.protectedPage('engine.html'));
    app.get('/integrations', security.protectedPage('bridge.html'));
    app.use('/api/admin', ...security.adminAuth);
    app.get('/api/admin/summary', (req, res) => res.json({ ok: true, actor: security.currentActor() }));
    app.get('/api/admin/bridge', (req, res) => res.json({ items: [] }));
    app.put('/api/admin/settings/development-test', (req, res, next) => {
      db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',
        [security.currentActor(), 'qa.development.write', 'isolated-test', '{}'])
        .then(() => res.json({ ok: true })).catch(next);
    });
    app.use(security.errorHandler);
    app.use((err, req, res, next) => {
      if (res.headersSent) return next(err);
      res.status(500).json({ error: err.code || 'TEST_SERVER_ERROR' });
    });
  }
  async function request(endpoint, method = 'GET', body, session, overrides = {}) {
    const headers = { Origin: base,
      ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}), ...overrides };
    const options = { method, headers, redirect: 'manual' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetch(base + endpoint, options);
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { data = { text: raw }; }
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, data, headers: response.headers,
      cookie: setCookie ? setCookie.split(';')[0] : session?.cookie, csrf: data.csrf || session?.csrf };
  }
  const enter = (value = key) => request('/api/auth/development', 'POST', { key: value });
  const ownerSnapshot = async () => (await db.query('SELECT * FROM gameops_admin_accounts ORDER BY username')).rows;
  const assertDenied = result => {
    assert.ok(result.status >= 400 && result.status < 500, 'request must be rejected');
    assert.equal(result.headers.get('set-cookie'), null);
  };

  await start();
  const accountsBefore = await ownerSnapshot();
  await t.test('default configuration leaves anonymous pages and APIs protected', async () => {
    const disabled = await enter(); assertDenied(disabled);
    assert.equal(disabled.data.code, 'DEVELOPMENT_UNAVAILABLE');
    assert.equal((await request('/api/admin/summary')).status, 401);
    assert.equal((await request('/api/auth/session')).status, 401);
    const page = await request('/engine');
    assert.equal(page.status, 302); assert.equal(page.headers.get('location'), '/login');
  });

  await start(enabled);
  await t.test('the exchange rejects missing, malformed, wrong and cross-site credentials', async () => {
    assertDenied(await request('/api/auth/development', 'POST', {}));
    assertDenied(await enter('admin'));
    assertDenied(await enter(crypto.randomBytes(32).toString('base64url')));
    assertDenied(await request('/api/auth/development', 'POST', { key }, undefined, { Origin: 'https://wrong.example' }));
    assertDenied(await request('/api/auth/development', 'POST', { key }, undefined, { 'Sec-Fetch-Site': 'cross-site' }));
    const nonJson = await fetch(base + '/api/auth/development', {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: 'fixture'
    });
    assert.ok(nonJson.status >= 400 && nonJson.status < 500); await nonJson.text();
    assert.equal(nonJson.headers.get('set-cookie'), null);
  });
  await db.query('DELETE FROM gameops_auth_buckets');
  await t.test('a valid link creates an honest development identity and opens dashboard pages', async () => {
    const landing = await request('/development');
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('cache-control'), 'no-store');
    assert.equal(landing.headers.get('referrer-policy'), 'no-referrer');
    assert.match(landing.headers.get('x-robots-tag'), /noindex/);
    assert.equal(landing.data.text.includes(key), false);
    development = await enter();
    assert.equal(development.status, 200);
    assert.equal(development.data.development, true);
    assert.equal(development.data.authenticationMethod, 'development-link');
    assert.equal(development.data.role, 'owner');
    assert.notEqual(development.data.username, 'qa_owner');
    assert.equal(development.data.setupRequired, false);
    assert.equal(development.data.mfaEnabled, false);
    assert.equal(development.data.mfaVerified, false);
    assert.equal(JSON.stringify(development.data).includes(key), false);
    assert.ok(development.csrf);
    assert.match(development.cookie, /^gameops_session=[A-Za-z0-9_-]{43}$/);
    assert.match(development.headers.get('set-cookie'), /HttpOnly/);
    assert.match(development.headers.get('set-cookie'), /SameSite=Strict/);
    assert.ok(new Date(development.data.expiresAt).getTime() > Date.now() + 86400000);
    assert.ok(new Date(development.data.expiresAt).getTime() <= Date.now() + 7 * 86400000 + 5000);
    for (const endpoint of ['/engine', '/engine-v1', '/integrations', '/api/admin/summary', '/api/admin/bridge']) {
      assert.equal((await request(endpoint, 'GET', undefined, development)).status, 200, endpoint);
    }
    assert.equal((await request('/api/admin/unknown-future-api', 'GET', undefined, development)).status, 403);
    assert.deepEqual(await ownerSnapshot(), accountsBefore);
  });
  await t.test('ordinary owner setup requirements and stored credentials remain intact', async () => {
    owner = await request('/api/auth/login', 'POST', { username: 'qa_owner', password: bootstrapPassword });
    assert.equal(owner.status, 200); assert.equal(owner.data.setupRequired, true);
    assert.equal(owner.data.passwordChangeRequired, true); assert.equal(owner.data.mfaEnabled, false);
    assert.equal((await request('/api/admin/summary', 'GET', undefined, owner)).status, 403);
    assert.deepEqual(await ownerSnapshot(), accountsBefore);
  });
  await t.test('development writes retain CSRF checks, origin checks and distinct audit attribution', async () => {
    const endpoint = '/api/admin/settings/development-test';
    assert.equal((await request(endpoint, 'PUT', {}, development, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request(endpoint, 'PUT', {}, development, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request(endpoint, 'PUT', {}, development)).status, 200);
    const audit = await db.query("SELECT actor FROM gameops_audit WHERE action='qa.development.write'");
    assert.deepEqual(audit.rows.map(row => row.actor), [development.data.username]);
  });
  await t.test('development sessions cannot change or inspect administrator credentials and access', async () => {
    const endpoints = [
      ['GET', '/api/security/admins'], ['POST', '/api/security/admins'],
      ['PATCH', '/api/security/admins/' + accountsBefore[0].id],
      ['POST', '/api/security/password'], ['POST', '/api/security/mfa/begin'],
      ['POST', '/api/security/mfa/confirm'], ['POST', '/api/security/mfa/reset']
    ];
    for (const [method, endpoint] of endpoints) {
      const result = await request(endpoint, method, method === 'GET' ? undefined : {}, development);
      assert.equal(result.status, 403, endpoint);
      assert.equal(result.data.code, 'DEVELOPMENT_SCOPE', endpoint);
    }
    assert.equal((await request('/api/security/me', 'GET', undefined, development)).status, 200);
    assert.deepEqual(await ownerSnapshot(), accountsBefore);
  });
  await t.test('session storage contains hashes and development does not inherit the 30-minute idle lock', async () => {
    const row = (await db.query('SELECT * FROM gameops_development_sessions WHERE id=$1', [development.data.sessionId])).rows[0];
    assert.ok(row);
    const rawCookie = development.cookie.split('=')[1];
    assert.equal(row.token_hash, hash(rawCookie));
    assert.equal(JSON.stringify(row).includes(rawCookie), false);
    assert.equal(JSON.stringify(row).includes(key), false);
    await db.query("UPDATE gameops_development_sessions SET last_seen=now()-interval '2 hours' WHERE id=$1", [development.data.sessionId]);
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 200);
  });
  await t.test('development session listings and revocations are scoped to the current session', async () => {
    const second = await enter(); assert.equal(second.status, 200);
    const list = await request('/api/security/sessions', 'GET', undefined, development);
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.items.map(item => item.id), [development.data.sessionId]);
    assert.equal(list.data.items[0].current, true);
    const otherDev = await request('/api/security/sessions/revoke', 'POST', { session_id: second.data.sessionId }, development);
    assert.ok(otherDev.status >= 400 && otherDev.status < 500);
    const ownerSession = await request('/api/security/sessions/revoke', 'POST', { session_id: owner.data.sessionId }, development);
    assert.ok(ownerSession.status >= 400 && ownerSession.status < 500);
    assert.equal((await request('/api/auth/session', 'GET', undefined, second)).status, 200);
    assert.equal((await request('/api/auth/session', 'GET', undefined, owner)).status, 200);
    const revoke = await request('/api/security/sessions/revoke', 'POST', { session_id: second.data.sessionId }, second);
    assert.equal(revoke.status, 200); assert.equal(revoke.data.signedOut, true);
    assert.equal((await request('/api/auth/session', 'GET', undefined, second)).status, 401);
  });
  await t.test('POST logout revokes the development cookie while GET logout has no side effect', async () => {
    await request('/logout', 'GET', undefined, development);
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 200);
    assert.equal((await request('/api/auth/logout', 'POST', {}, development, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/api/auth/logout', 'POST', {}, development)).status, 200);
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 401);
  });
  await t.test('database expiry invalidates development sessions', async () => {
    const expired = await enter(); assert.equal(expired.status, 200);
    await db.query("UPDATE gameops_development_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.data.sessionId]);
    assert.equal((await request('/api/auth/session', 'GET', undefined, expired)).status, 401);
  });
  await t.test('sessions survive restart only with the same enabled development configuration', async () => {
    development = await enter(); assert.equal(development.status, 200);
    await start(enabled);
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 200);
    await start({ ...enabled, enabled: false });
    assertDenied(await enter());
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 401);
    await start(enabled);
    development = await enter(); assert.equal(development.status, 200);
    await start({ ...enabled, keyHash: hash(crypto.randomBytes(32).toString('base64url')) });
    assertDenied(await enter());
    assert.equal((await request('/api/auth/session', 'GET', undefined, development)).status, 401);
  });
  await t.test('credential deadline caps session duration and expired configuration fails closed', async () => {
    const nearDeadline = new Date(Date.now() + 3600000).toISOString();
    await start({ ...enabled, expiresAt: nearDeadline });
    const bounded = await enter(); assert.equal(bounded.status, 200);
    assert.ok(new Date(bounded.data.expiresAt).getTime() <= new Date(nearDeadline).getTime());
    await start({ ...enabled, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await enter(); assertDenied(expired);
    assert.equal(expired.data.code, 'DEVELOPMENT_UNAVAILABLE');
    assert.equal((await request('/api/auth/session', 'GET', undefined, bounded)).status, 401);
  });
  assert.deepEqual(await ownerSnapshot(), accountsBefore);
});
