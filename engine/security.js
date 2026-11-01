'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const C = require('./security-crypto');
const policy = require('./security-policy');
const COOKIE = 'gameops_session';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class AuthError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'AUTH_ERROR'; }
}
function publicAccount(a) {
  return { id: a.id, username: a.username, displayName: a.display_name, role: a.role, status: a.status,
    mfaEnabled: a.mfa_enabled, passwordChangeRequired: a.must_change_password,
    setupRequired: a.must_change_password || !a.mfa_enabled };
}
const ddl = `
CREATE TABLE IF NOT EXISTS gameops_admin_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text NOT NULL UNIQUE,
 display_name text NOT NULL, role text NOT NULL CHECK(role IN ('owner','operator','support','viewer')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 password_hash text NOT NULL, must_change_password boolean NOT NULL DEFAULT true,
 mfa_enabled boolean NOT NULL DEFAULT false, mfa_secret text, mfa_last_step bigint NOT NULL DEFAULT -1,
 mfa_pending text, mfa_pending_until timestamptz, mfa_pending_session uuid,
 recovery_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
 auth_version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gameops_admin_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES gameops_admin_accounts(id),
 token_hash text NOT NULL UNIQUE, auth_version integer NOT NULL, mfa_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, ip text NOT NULL DEFAULT '', user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS gameops_admin_sessions_admin_idx ON gameops_admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS gameops_admin_sessions_expiry_idx ON gameops_admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS gameops_auth_buckets (
 key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gameops_auth_buckets_expiry_idx ON gameops_auth_buckets(expires_at);
`;
function createSecurity({ pool, master, bootstrapUser, bootstrapPassword, publicOrigin, production = false, publicDir }) {
  const vault = C.encryption(master), actorContext = new AsyncLocalStorage();
  let dummyHash;
  const origin = new URL(publicOrigin).origin;
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/', maxAge: 8 * 3600000 };
  async function transaction(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async function audit(db, actor, action, resource, details = {}) {
    await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',
      [actor, action, String(resource), JSON.stringify(details)]);
  }
  async function init() {
    await transaction(async db => {
      await db.query('SELECT pg_advisory_xact_lock(812083001)');
      await db.query(ddl);
      const exists = await db.query('SELECT 1 FROM gameops_admin_accounts LIMIT 1');
      if (!exists.rowCount) {
        const username = String(bootstrapUser || '').trim().toLowerCase();
        if (!USERNAME.test(username) || !C.passwordValid(bootstrapPassword)) throw new Error('Valid bootstrap admin credentials required for first CP08 startup');
        const hash = await C.passwordHash(bootstrapPassword);
        const a = await db.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash) VALUES($1,$2,'owner',$3) RETURNING id", [username, 'Platform Owner', hash]);
        await audit(db, 'system', 'security.bootstrap.completed', a.rows[0].id, { mandatoryPasswordChange: true, mandatoryMfa: true });
      }
      // Existing CP07 tables remain intact. Its signed cookies are never accepted by CP08.
      await db.query("DELETE FROM gameops_admin_sessions WHERE expires_at < now() OR last_seen < now()-interval '30 minutes'");
      await db.query('DELETE FROM gameops_auth_buckets WHERE expires_at < now()');
    });
    dummyHash = await C.passwordHash(crypto.randomBytes(24).toString('base64url'));
  }
  function tokenFrom(req) {
    const value = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
    const raw = value ? value.slice(COOKIE.length + 1) : '';
    return /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
  }
  function csrf(raw) { return crypto.createHmac('sha256', master).update('cp08:csrf:' + raw).digest('base64url'); }
  async function session(req) {
    const raw = tokenFrom(req); if (!raw) return null;
    const q = await pool.query(`SELECT a.*, s.id AS session_id, s.mfa_verified, s.expires_at,
       s.auth_version AS session_version, s.last_seen
      FROM gameops_admin_sessions s JOIN gameops_admin_accounts a ON a.id=s.admin_id
      WHERE s.token_hash=$1 AND a.status='active' AND s.auth_version=a.auth_version
       AND s.expires_at>now() AND s.last_seen>now()-interval '30 minutes'`, [C.sha(raw)]);
    if (!q.rowCount) return null;
    const a = q.rows[0];
    await pool.query("UPDATE gameops_admin_sessions SET last_seen=now() WHERE id=$1 AND last_seen < now()-interval '1 minute'", [a.session_id]);
    return { ...a, raw };
  }
  function full(a) { return !a.must_change_password && a.mfa_enabled && a.mfa_verified; }
  function state(a) { return { ...publicAccount(a), username: a.username, csrf: csrf(a.raw), expiresAt: a.expires_at, sessionId: a.session_id, mfaVerified: a.mfa_verified, setupRequired: !full(a) }; }
  function checkOrigin(req) {
    const supplied = req.get('Origin');
    if ((supplied && supplied !== origin) || req.get('Sec-Fetch-Site') === 'cross-site') throw new AuthError(403, 'Cross-site request rejected', 'ORIGIN_REJECTED');
  }
  function checkWrite(req, a) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    checkOrigin(req);
    if (!req.is('application/json')) throw new AuthError(415, 'JSON request required');
    if (!C.equal(req.get('X-CSRF-Token') || '', csrf(a.raw))) throw new AuthError(403, 'CSRF validation failed', 'CSRF_REJECTED');
  }
  async function throttle(key, max = 10, seconds = 900) {
    const q = await pool.query(`INSERT INTO gameops_auth_buckets(key,hits,expires_at) VALUES($1,1,now()+($2 * interval '1 second'))
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN gameops_auth_buckets.expires_at<now() THEN 1 ELSE gameops_auth_buckets.hits+1 END,
      expires_at=CASE WHEN gameops_auth_buckets.expires_at<now() THEN now()+($2 * interval '1 second') ELSE gameops_auth_buckets.expires_at END RETURNING hits`, [C.sha(key), seconds]);
    if (q.rows[0].hits > max) throw new AuthError(429, 'Too many attempts. Try again in 15 minutes.', 'RATE_LIMITED');
  }
  async function newSession(db, account, verified, req) {
    const raw = crypto.randomBytes(32).toString('base64url');
    const q = await db.query(`INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at,ip,user_agent)
      VALUES($1,$2,$3,$4,now()+interval '8 hours',$5,$6) RETURNING id,expires_at`,
      [account.id, C.sha(raw), account.auth_version, verified, String(req.ip || '').slice(0,64), String(req.get('User-Agent') || '').slice(0,300)]);
    return { ...account, raw, mfa_verified: verified, session_id: q.rows[0].id, expires_at: q.rows[0].expires_at };
  }
  function sendSession(res, a, extra = {}) { res.cookie(COOKIE, a.raw, cookieOptions); res.json({ ...state(a), ...extra }); }
  async function factor(db, account, code) {
    if (!account.mfa_enabled) return false;
    const step = C.matchTotp(vault.open(account.mfa_secret, account.id), code, account.mfa_last_step);
    if (step !== null) {
      const q = await db.query('UPDATE gameops_admin_accounts SET mfa_last_step=$2 WHERE id=$1 AND mfa_last_step<$2 RETURNING id', [account.id, step]);
      return !!q.rowCount;
    }
    if (typeof code !== 'string' || !/^[A-Fa-f0-9\s-]{32,48}$/.test(code)) return false;
    const hash = C.recoveryHash(master, account.id, code);
    const hashes = account.recovery_hashes || [];
    const idx = hashes.findIndex(x => C.equal(x, hash));
    if (idx < 0) return false;
    hashes.splice(idx, 1);
    await db.query('UPDATE gameops_admin_accounts SET recovery_hashes=$2 WHERE id=$1', [account.id, JSON.stringify(hashes)]);
    await audit(db, account.username, 'security.recovery_code.used', account.id);
    return true;
  }
  async function reauthenticate(db, account, body, needsFactor = true) {
    if (!await C.passwordVerify(body.current_password, account.password_hash)) throw new AuthError(401, 'Password or authentication code is incorrect', 'REAUTH_FAILED');
    if (needsFactor && account.mfa_enabled && !await factor(db, account, body.code)) throw new AuthError(401, 'Password or authentication code is incorrect or already used', 'REAUTH_FAILED');
  }
  const authenticated = wrap(async (req, res, next) => {
    const a = await session(req);
    if (!a) throw new AuthError(401, 'Login required', 'LOGIN_REQUIRED');
    checkWrite(req, a); req.auth = a;
    req.admin = { id: a.id, u: a.username, role: a.role };
    actorContext.run(a.username, next);
  });
  const adminAuth = [authenticated, wrap(async (req, res, next) => {
    if (!full(req.auth)) throw new AuthError(403, 'Complete password and authenticator setup in Security Center', 'SETUP_REQUIRED');
    if (!policy.canAccess(req.auth.role, req.method, req.path)) throw new AuthError(403, 'Your role cannot access this action', 'FORBIDDEN');
    next();
  })];
  const owner = (req, res, next) => {
    if (!full(req.auth) || req.auth.role !== 'owner') return next(new AuthError(403, 'Fully enrolled owner access required', 'FORBIDDEN'));
    next();
  };
  const protectedPage = filename => wrap(async (req, res) => {
    const a = await session(req); if (!a) return res.redirect('/login');
    if (!full(a)) return res.redirect('/security');
    res.sendFile(path.join(publicDir, filename));
  });
  async function lockedSelf(db, req) {
    const q = await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE', [req.auth.id]);
    const a = q.rows[0];
    if (!a || a.status !== 'active' || a.auth_version !== req.auth.auth_version) throw new AuthError(401, 'Session changed. Sign in again.');
    const s = await db.query('SELECT 1 FROM gameops_admin_sessions WHERE id=$1 AND admin_id=$2 AND expires_at>now()', [req.auth.session_id, a.id]);
    if (!s.rowCount) throw new AuthError(401, 'Session no longer active');
    return a;
  }
  function mount(app) {
    app.get('/login', wrap(async (req, res) => {
      const a = await session(req); return a ? res.redirect(full(a) ? '/engine' : '/security') : res.sendFile(path.join(publicDir, 'login.html'));
    }));
    app.get('/security', wrap(async (req, res) => {
      if (!await session(req)) return res.redirect('/login');
      res.sendFile(path.join(publicDir, 'security.html'));
    }));
    app.get('/logout', (req, res) => res.redirect('/security')); // GET cannot revoke sessions.
    for (const filename of ['login.js','security-ui.js','security.css','security-nav.js']) {
      app.get('/assets/' + filename, (req, res) => res.sendFile(path.join(publicDir, filename)));
    }
    app.post('/api/auth/login', wrap(async (req, res) => {
      checkOrigin(req); if (!req.is('application/json')) throw new AuthError(415, 'JSON request required');
      const username = String(req.body?.username || '').trim().toLowerCase();
      if (!USERNAME.test(username) || typeof req.body?.password !== 'string' || req.body.password.length > 128) throw new AuthError(401, 'Invalid credentials');
      await throttle('login-ip:' + req.ip, 100); await throttle('login-user:' + username, 10);
      const found = await pool.query('SELECT * FROM gameops_admin_accounts WHERE username=$1', [username]);
      const a = found.rows[0];
      const valid = await C.passwordVerify(req.body.password, a?.password_hash || dummyHash);
      if (!valid || !a || a.status !== 'active') {
        await pool.query('INSERT INTO gameops_login_history(username,success,ip) VALUES($1,false,$2)', [username, String(req.ip || '').slice(0,64)]);
        throw new AuthError(401, 'Invalid credentials', 'INVALID_CREDENTIALS');
      }
      if (a.mfa_enabled && !req.body.code) return res.status(202).json({ code: 'MFA_REQUIRED', error: 'Enter an authenticator code or an unused recovery code.' });
      const loggedIn = await transaction(async db => {
        const locked = (await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE', [a.id])).rows[0];
        if (locked.status !== 'active' || locked.auth_version !== a.auth_version) throw new AuthError(401, 'Sign-in state changed. Try again.');
        if (locked.mfa_enabled && !await factor(db, locked, req.body.code)) throw new AuthError(401, 'Code is invalid, expired, or already used', 'INVALID_MFA');
        const result = await newSession(db, locked, locked.mfa_enabled, req);
        await db.query('INSERT INTO gameops_login_history(username,success,ip) VALUES($1,true,$2)', [username, String(req.ip || '').slice(0,64)]);
        await audit(db, username, 'security.login.succeeded', result.session_id, { mfa: locked.mfa_enabled });
        return result;
      });
      sendSession(res, loggedIn);
    }));
    app.get('/api/auth/session', authenticated, (req, res) => res.json(state(req.auth)));
    app.post('/api/auth/logout', authenticated, wrap(async (req, res) => {
      await transaction(async db => {
        await db.query('DELETE FROM gameops_admin_sessions WHERE id=$1 AND admin_id=$2', [req.auth.session_id, req.auth.id]);
        await audit(db, req.auth.username, 'security.logout', req.auth.session_id);
      });
      res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined }); res.json({ ok: true });
    }));
    app.use('/api/security', authenticated);
    app.get('/api/security/me', (req, res) => res.json(state(req.auth)));
    app.get('/api/security/sessions', wrap(async (req, res) => {
      const q = await pool.query("SELECT id,created_at,last_seen,expires_at,ip,user_agent FROM gameops_admin_sessions WHERE admin_id=$1 AND expires_at>now() AND last_seen>now()-interval '30 minutes' ORDER BY created_at DESC LIMIT 100", [req.auth.id]);
      res.json({ items: q.rows.map(s => ({ ...s, current: s.id === req.auth.session_id })) });
    }));
    app.post('/api/security/sessions/revoke', wrap(async (req, res) => {
      const sid = req.body.session_id;
      if (!UUID.test(sid || '')) throw new AuthError(400, 'Invalid session');
      const q = await pool.query('DELETE FROM gameops_admin_sessions WHERE id=$1 AND admin_id=$2 RETURNING id', [sid, req.auth.id]);
      if (!q.rowCount) throw new AuthError(404, 'Session not found');
      await audit(pool, req.auth.username, 'security.session.revoked', sid);
      const signedOut = sid === req.auth.session_id; if (signedOut) res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
      res.json({ ok: true, signedOut });
    }));
    app.post('/api/security/password', wrap(async (req, res) => {
      if (!C.passwordValid(req.body.new_password)) throw new AuthError(400, 'New password must contain 15 to 128 characters');
      await throttle('reauth:' + req.auth.id);
      const hash = await C.passwordHash(req.body.new_password);
      const a = await transaction(async db => {
        const old = await lockedSelf(db, req); await reauthenticate(db, old, req.body);
        if (await C.passwordVerify(req.body.new_password, old.password_hash)) throw new AuthError(400, 'Choose a different password');
        const changed = await db.query('UPDATE gameops_admin_accounts SET password_hash=$2,must_change_password=false,auth_version=auth_version+1,updated_at=now() WHERE id=$1 RETURNING *', [old.id, hash]);
        await db.query('DELETE FROM gameops_admin_sessions WHERE admin_id=$1', [old.id]);
        await audit(db, old.username, 'security.password.changed', old.id, { sessionsRevoked: true });
        return newSession(db, changed.rows[0], old.mfa_enabled && req.auth.mfa_verified, req);
      });
      sendSession(res, a);
    }));
    app.post('/api/security/mfa/begin', wrap(async (req, res) => {
      await throttle('reauth:' + req.auth.id);
      const secret = C.base32(crypto.randomBytes(20));
      await transaction(async db => {
        const a = await lockedSelf(db, req);
        if (a.must_change_password) throw new AuthError(403, 'Change the temporary password first');
        if (a.mfa_enabled) throw new AuthError(409, 'Authenticator is already enabled');
        await reauthenticate(db, a, req.body, false);
        await db.query("UPDATE gameops_admin_accounts SET mfa_pending=$2,mfa_pending_until=now()+interval '10 minutes',mfa_pending_session=$3 WHERE id=$1", [a.id, vault.seal(secret, a.id), req.auth.session_id]);
        await audit(db, a.username, 'security.mfa.enrollment.started', a.id);
      });
      const label = encodeURIComponent('Playground:' + req.auth.username);
      res.json({ secret, uri: 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=Playground&algorithm=SHA1&digits=6&period=30', expiresInSeconds: 600 });
    }));
    app.post('/api/security/mfa/confirm', wrap(async (req, res) => {
      await throttle('factor:' + req.auth.id);
      const codes = C.recoveryCodes();
      const a = await transaction(async db => {
        const old = await lockedSelf(db, req);
        if (old.mfa_enabled || !old.mfa_pending || old.mfa_pending_session !== req.auth.session_id || new Date(old.mfa_pending_until).getTime() < Date.now()) throw new AuthError(409, 'Start a new authenticator enrollment');
        const step = C.matchTotp(vault.open(old.mfa_pending, old.id), req.body.code);
        if (step === null) throw new AuthError(400, 'Authenticator code is invalid');
        const changed = await db.query(`UPDATE gameops_admin_accounts SET mfa_enabled=true,mfa_secret=mfa_pending,
          mfa_pending=null,mfa_pending_until=null,mfa_pending_session=null,mfa_last_step=$2,recovery_hashes=$3,
          auth_version=auth_version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [old.id, step, JSON.stringify(codes.map(code => C.recoveryHash(master, old.id, code)))]);
        await db.query('DELETE FROM gameops_admin_sessions WHERE admin_id=$1', [old.id]);
        await audit(db, old.username, 'security.mfa.enabled', old.id, { recoveryCodeCount: codes.length });
        return newSession(db, changed.rows[0], true, req);
      });
      sendSession(res, a, { recoveryCodes: codes });
    }));
    app.post('/api/security/mfa/reset', wrap(async (req, res) => {
      await throttle('reauth:' + req.auth.id);
      const a = await transaction(async db => {
        const old = await lockedSelf(db, req);
        if (!old.mfa_enabled) throw new AuthError(409, 'Authenticator is not enabled');
        await reauthenticate(db, old, req.body);
        const changed = await db.query(`UPDATE gameops_admin_accounts SET mfa_enabled=false,mfa_secret=null,mfa_last_step=-1,
          recovery_hashes='[]'::jsonb,mfa_pending=null,mfa_pending_until=null,mfa_pending_session=null,
          auth_version=auth_version+1,updated_at=now() WHERE id=$1 RETURNING *`, [old.id]);
        await db.query('DELETE FROM gameops_admin_sessions WHERE admin_id=$1', [old.id]);
        await audit(db, old.username, 'security.mfa.reset', old.id, { reenrollmentRequired: true });
        return newSession(db, changed.rows[0], false, req);
      });
      sendSession(res, a);
    }));
    app.get('/api/security/admins', owner, wrap(async (req, res) => {
      const q = await pool.query('SELECT id,username,display_name,role,status,mfa_enabled,must_change_password,created_at FROM gameops_admin_accounts ORDER BY created_at');
      res.json({ items: q.rows.map(publicAccount), roles: policy.roles });
    }));
    app.post('/api/security/admins', owner, wrap(async (req, res) => {
      const p = req.body, username = String(p.username || '').trim().toLowerCase();
      if (!USERNAME.test(username) || typeof p.display_name !== 'string' || !p.display_name.trim() || p.display_name.length > 100 || !policy.roles.includes(p.role) || !C.passwordValid(p.temporary_password)) throw new AuthError(400, 'Invalid admin fields or temporary password');
      await throttle('reauth:' + req.auth.id);
      const hash = await C.passwordHash(p.temporary_password);
      const created = await transaction(async db => {
        const a = await lockedSelf(db, req); if (a.role !== 'owner') throw new AuthError(403, 'Owner required');
        await reauthenticate(db, a, p);
        const q = await db.query('INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING RETURNING *', [username, p.display_name.trim(), p.role, hash]);
        if (!q.rowCount) throw new AuthError(409, 'Username already exists');
        await audit(db, a.username, 'security.admin.created', q.rows[0].id, { username, role: p.role });
        return q.rows[0];
      });
      res.status(201).json({ item: publicAccount(created) });
    }));
    app.patch('/api/security/admins/:id', owner, wrap(async (req, res) => {
      const p = req.body;
      if (!UUID.test(req.params.id) || !policy.roles.includes(p.role) || !['active', 'disabled'].includes(p.status)) throw new AuthError(400, 'Invalid account change');
      if (req.params.id === req.auth.id) throw new AuthError(409, 'You cannot change your own role or disable your own account');
      await throttle('reauth:' + req.auth.id);
      const updated = await transaction(async db => {
        await db.query('SELECT pg_advisory_xact_lock(812083002)');
        const a = await lockedSelf(db, req); if (a.role !== 'owner') throw new AuthError(403, 'Owner required');
        await reauthenticate(db, a, p);
        const target = (await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
        if (!target) throw new AuthError(404, 'Account not found');
        if (target.role === 'owner' && target.status === 'active' && (p.role !== 'owner' || p.status !== 'active')) {
          const count = await db.query("SELECT count(*)::int AS total FROM gameops_admin_accounts WHERE role='owner' AND status='active'");
          if (count.rows[0].total <= 1) throw new AuthError(409, 'The last active owner must be retained');
        }
        const q = await db.query('UPDATE gameops_admin_accounts SET role=$2,status=$3,auth_version=auth_version+1,updated_at=now() WHERE id=$1 RETURNING *', [target.id, p.role, p.status]);
        await db.query('DELETE FROM gameops_admin_sessions WHERE admin_id=$1', [target.id]);
        await audit(db, a.username, 'security.admin.updated', target.id, { role: p.role, status: p.status, sessionsRevoked: true });
        return q.rows[0];
      });
      res.json({ item: publicAccount(updated) });
    }));
  }
  function errorHandler(err, req, res, next) {
    if (!(err instanceof AuthError)) return next(err);
    if (err.status === 429) res.set('Retry-After', '900');
    res.status(err.status).json({ error: err.message, code: err.code });
  }
  return { init, mount, adminAuth, authenticated, session, full, protectedPage, errorHandler,
    currentActor: () => actorContext.getStore() || 'system', state };
}
module.exports = { createSecurity, AuthError, publicAccount };
