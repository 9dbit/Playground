'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const ROOT = path.join(__dirname, '../..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function portNumber() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function createFixture(label = 'cp14') {
  if (process.env.CI !== 'true') throw Error('Full-server tests require isolated CI');
  const url = new URL(process.env.TEST_DATABASE_URL || 'http://invalid');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/gameops_ci') {
    throw Error('Full-server tests refuse non-localhost or non-gameops_ci databases');
  }
  const schema = 'cp14_' + crypto.randomBytes(8).toString('hex');
  const root = new Pool({ connectionString: url.toString() });
  await root.query('CREATE SCHEMA ' + schema);
  url.searchParams.set('options', '-c search_path=' + schema + ',public');
  const pool = new Pool({ connectionString: url.toString() });
  const master = crypto.randomBytes(48).toString('hex');
  const password = crypto.randomBytes(32).toString('base64url');
  const port = await portNumber(), base = 'http://127.0.0.1:' + port;
  const accounts = new Map(); let child, logs = '';
  async function request(endpoint, method = 'GET', body, role = 'owner', extraHeaders = {}) {
    const auth = role && accounts.get(role);
    const res = await fetch(base + endpoint, { method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { Origin: base, ...(auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const bytes = Buffer.from(await res.arrayBuffer()), text = bytes.toString('utf8');
    let data = null; try { data = JSON.parse(text); } catch { /* HTML/image response */ }
    return { status: res.status, data, text, bytes, headers: res.headers };
  }
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, DATABASE_URL: url.toString(), SESSION_SECRET: master, ADMIN_USERNAME: 'fixture_owner', ADMIN_PASSWORD: password,
      PUBLIC_SITE_URL: base, RAILWAY_PUBLIC_DOMAIN: '', NODE_ENV: 'test', PORT: String(port),
      GAMEOPS_BRIDGE_KEYS: '[]', DEV_ACCESS_ENABLED: 'false'
    } });
    const append = bytes => { logs = (logs + bytes.toString()).slice(-40000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    for (let i = 0; i < 160; i++) {
      if (child.exitCode !== null) throw Error('Fixture exited: ' + logs.slice(-1200));
      try { const r = await request('/health', 'GET', undefined, null); if (r.status === 200) return r.data; } catch { /* wait for listener */ }
      await delay(150);
    }
    throw Error('Fixture startup timed out: ' + logs.slice(-1200));
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const proc = child;
    await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 9000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); }); proc.kill('SIGTERM');
    });
  }
  async function close() {
    try { await stop(); } finally {
      fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'test-results', label + '-server.log'), logs);
      await pool.end();
      try { await root.query('DROP SCHEMA ' + schema + ' CASCADE'); } finally { await root.end(); }
    }
  }
  try {
    const health = await start();
    const owner = (await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='fixture_owner' RETURNING id,password_hash")).rows[0];
    for (const role of ['owner', 'operator', 'support', 'viewer']) {
      const username = 'fixture_' + role;
      const id = role === 'owner' ? owner.id : (await pool.query('INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash,must_change_password,mfa_enabled) VALUES($1,$1,$2,$3,false,true) RETURNING id', [username, role, owner.password_hash])).rows[0].id;
      const raw = crypto.randomBytes(32).toString('base64url');
      const session = await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '1 hour') RETURNING id", [id, hash(raw)]);
      accounts.set(role, { id, username, raw, cookie: 'gameops_session=' + raw, sessionId: session.rows[0].id,
        csrf: crypto.createHmac('sha256', master).update('cp08:csrf:' + raw).digest('base64url') });
    }
    return { pool, base, request, accounts, close, start, stop, health };
  } catch (e) { await close(); throw e; }
}
module.exports = { createFixture };
