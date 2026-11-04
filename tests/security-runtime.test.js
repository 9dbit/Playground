'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { createSecurity } = require('../engine/security');
const C = require('../engine/security-crypto');

test('Runtime master recovery with real HTTP sessions and isolated PostgreSQL', { timeout: 180000 }, async t => {
  let pool, root, schema;
  if (process.env.TEST_DATABASE_URL) {
    const { Pool } = require('pg');
    root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    schema = 'runtime_test_' + crypto.randomBytes(8).toString('hex');
    await root.query('CREATE SCHEMA ' + schema);
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + schema + ',pg_catalog' });
  } else pool = new (require('./helpers/pglite-pool.cjs').Pool)();
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
    if (root) { await root.query('DROP SCHEMA ' + schema + ' CASCADE'); await root.end(); }
  });
  await pool.query(`CREATE TABLE gameops_audit(id bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,
    resource text NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE gameops_login_history(id bigserial PRIMARY KEY,username text,success boolean,ip text);
    CREATE TABLE preserved_agent_ledger(id integer PRIMARY KEY,balance bigint NOT NULL);
    INSERT INTO preserved_agent_ledger VALUES(1,1234567);`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const boot = 'Synthetic original bootstrap password';
  const privatePassword = 'Synthetic password chosen inside panel';
  const envPassword = 'Synthetic recovered Railway password';
  const panelPassword = 'Synthetic next password chosen in panel';
  const cfg = { pool, master: crypto.randomBytes(48).toString('hex'), bootstrapUser: 'original_master', bootstrapPassword: boot,
    publicOrigin: base, publicDir: path.join(__dirname, '../public') };
  async function restart(extra = {}) {
    const security = createSecurity({ ...cfg, ...extra });
    await security.init();
    const app = express(); app.use(express.json()); security.mount(app);
    app.get('/private', security.authenticated, (req, res) => res.json({ id: req.auth.id }));
    app.use(security.errorHandler); handler = app;
  }
  async function req(endpoint, method = 'GET', body, session) {
    const headers = { Origin: base, ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.data.csrf } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { text }; }
    return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] || session?.cookie };
  }
  const login = (username, password, code) => req('/api/auth/login', 'POST', { username, password, code });
  const ownerRow = async () => (await pool.query('SELECT * FROM gameops_admin_accounts WHERE id=$1', [ownerId])).rows[0];
  const syncCount = async () => Number((await pool.query("SELECT count(*) AS n FROM gameops_audit WHERE action='security.runtime_credentials.synced'")).rows[0].n);
  await restart();
  let owner = await login('original_master', boot);
  const ownerId = owner.data.id;
  owner = await req('/api/security/password', 'POST', { current_password: boot, new_password: privatePassword }, owner);
  const mfa = await req('/api/security/mfa/begin', 'POST', { current_password: privatePassword }, owner);
  owner = await req('/api/security/mfa/confirm', 'POST', { code: C.totp(mfa.data.secret, Math.floor(Date.now() / 30000)) }, owner);
  assert.equal(owner.status, 200);
  const codes = owner.data.recoveryCodes;
  const originalMfa = (await ownerRow()).mfa_secret;
  const viewerHash = await C.passwordHash('Synthetic independent viewer password');
  await pool.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash) VALUES('other_user','Other user','viewer',$1)", [viewerHash]);
  const viewerBefore = (await pool.query("SELECT * FROM gameops_admin_accounts WHERE username='other_user'")).rows[0];
  const synced = { runtimeCredentialSync: true, bootstrapUser: 'renamed_master', bootstrapPassword: envPassword };

  await t.test('disabled synchronization retains legacy bootstrap-only behavior', async () => {
    await restart({ bootstrapUser: 'renamed_master', bootstrapPassword: envPassword });
    assert.deepEqual((await req('/api/auth/recovery-options')).data, { environmentCredentials: false });
    assert.equal((await login('renamed_master', envPassword)).status, 401);
    assert.equal((await login('original_master', privatePassword, codes[0])).status, 200);
    assert.equal(await syncCount(), 0);
  });
  await t.test('first opt-in recovers and renames the original owner exactly once across simultaneous startups', async () => {
    // An accumulated username throttle must not keep the owner locked out after recovery.
    await pool.query("INSERT INTO gameops_auth_buckets(key,hits,expires_at) VALUES($1,20,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET hits=20", [C.sha('login-user:renamed_master')]);
    await Promise.all([restart(synced), restart(synced)]);
    assert.equal(await syncCount(), 1);
    const account = await ownerRow();
    assert.equal(account.username, 'renamed_master');
    assert.equal(account.must_change_password, false);
    assert.equal((await req('/private', 'GET', undefined, owner)).status, 401);
    assert.equal((await login('original_master', privatePassword)).status, 401);
    assert.equal((await login('renamed_master', privatePassword)).status, 401);
    assert.equal((await login('renamed_master', envPassword)).data.code, 'MFA_REQUIRED');
    owner = await login('renamed_master', envPassword, codes[1]);
    assert.equal(owner.status, 200); assert.equal(owner.data.id, ownerId);
    assert.equal(account.mfa_secret, originalMfa);
  });
  await t.test('recovery metadata is public, non-mutating and contains no credentials or account identifiers', async () => {
    assert.deepEqual((await req('/api/auth/recovery-options')).data, { environmentCredentials: true });
    assert.equal((await req('/api/auth/recovery-options', 'POST', { username: 'attacker' })).status, 404);
    assert.equal(await syncCount(), 1);
  });
  await t.test('unchanged deploy retains hash, session, authenticator and auth version', async () => {
    const before = await ownerRow(); await restart(synced);
    assert.deepEqual(await ownerRow(), before);
    assert.equal((await req('/private', 'GET', undefined, owner)).status, 200);
    assert.equal(await syncCount(), 1);
  });
  await t.test('panel password change survives restart with unchanged environment credentials', async () => {
    owner = await req('/api/security/password', 'POST', { current_password: envPassword, new_password: panelPassword, code: codes[2] }, owner);
    assert.equal(owner.status, 200);
    await restart(synced);
    assert.equal((await login('renamed_master', envPassword)).status, 401);
    assert.equal((await login('renamed_master', panelPassword, codes[3])).status, 200);
    assert.equal(await syncCount(), 1);
  });
  await t.test('explicit recovery revision reapplies credentials once without resetting MFA', async () => {
    synced.runtimeCredentialRevision = 'recovery-2';
    await restart(synced); await restart(synced);
    assert.equal(await syncCount(), 2);
    assert.equal((await req('/private', 'GET', undefined, owner)).status, 401);
    owner = await login('renamed_master', envPassword, codes[4]);
    assert.equal(owner.status, 200); assert.equal(owner.data.id, ownerId);
    assert.equal((await ownerRow()).mfa_secret, originalMfa);
  });
  await t.test('username-only changes update the same owner and invalidate the previous username', async () => {
    synced.bootstrapUser = 'final_master';
    await restart(synced);
    assert.equal(await syncCount(), 3);
    assert.equal((await login('renamed_master', envPassword)).status, 401);
    assert.equal((await login('final_master', envPassword, codes[5])).data.id, ownerId);
  });
  await t.test('duplicate username and invalid credentials fail atomically without changing accounts', async () => {
    const before = await ownerRow();
    const saved = (await pool.query('SELECT * FROM gameops_runtime_credentials')).rows;
    await assert.rejects(restart({ ...synced, bootstrapUser: 'other_user' }), /already used/);
    await assert.rejects(restart({ ...synced, bootstrapPassword: 'short' }), /15–128/);
    await assert.rejects(restart({ ...synced, bootstrapPassword: undefined }), /15–128/);
    await assert.rejects(restart({ ...synced, bootstrapUser: 'bad user' }), /ADMIN_USERNAME/);
    assert.deepEqual(await ownerRow(), before);
    assert.deepEqual((await pool.query('SELECT * FROM gameops_runtime_credentials')).rows, saved);
  });
  await t.test('disabled or demoted owners cannot be reactivated or promoted by environment sync', async () => {
    await pool.query("UPDATE gameops_admin_accounts SET status='disabled' WHERE id=$1", [ownerId]);
    await assert.rejects(restart({ ...synced, runtimeCredentialRevision: 'disabled-owner' }), /disabled/);
    assert.equal((await ownerRow()).status, 'disabled');
    await pool.query("UPDATE gameops_admin_accounts SET status='active',role='viewer' WHERE id=$1", [ownerId]);
    await assert.rejects(restart({ ...synced, runtimeCredentialRevision: 'demoted-owner' }), /non-owner/);
    assert.equal((await ownerRow()).role, 'viewer');
    await pool.query("UPDATE gameops_admin_accounts SET role='owner' WHERE id=$1", [ownerId]);
  });
  await t.test('first adoption fails safely when bootstrap identity is missing or ambiguous', async () => {
    await pool.query('DELETE FROM gameops_runtime_credentials');
    await pool.query("UPDATE gameops_audit SET action='test.saved.bootstrap' WHERE action='security.bootstrap.completed'");
    const before = await ownerRow();
    await assert.rejects(restart(synced), /verified bootstrap/);
    await pool.query("UPDATE gameops_audit SET action='security.bootstrap.completed' WHERE action='test.saved.bootstrap'");
    await pool.query("INSERT INTO gameops_audit(actor,action,resource) VALUES('system','security.bootstrap.completed',$1)", [viewerBefore.id]);
    await assert.rejects(restart(synced), /verified bootstrap/);
    assert.deepEqual(await ownerRow(), before);
  });
  await t.test('unrelated users and business data are intact; audit contains no passwords', async () => {
    assert.deepEqual((await pool.query("SELECT * FROM gameops_admin_accounts WHERE username='other_user'")).rows[0], viewerBefore);
    assert.equal(String((await pool.query('SELECT balance FROM preserved_agent_ledger')).rows[0].balance), '1234567');
    const audit = JSON.stringify((await pool.query('SELECT * FROM gameops_audit')).rows);
    for (const password of [boot, privatePassword, envPassword, panelPassword]) assert.equal(audit.includes(password), false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_admin_accounts')).rows[0].n, 2);
  });
});
