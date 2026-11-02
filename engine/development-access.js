'use strict';
const crypto = require('node:crypto');
const C = require('./security-crypto');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const ddl = `
CREATE TABLE IF NOT EXISTS gameops_development_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE,
 key_fingerprint text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_seen timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 ip text NOT NULL DEFAULT '', user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS gameops_development_sessions_expiry_idx ON gameops_development_sessions(expires_at);
`;

// This is a separate authentication method, never a change to an owner's MFA state.
function createDevelopmentAccess({ pool, config = {} }) {
  const enabled = config.enabled === true;
  const keyHash = typeof config.keyHash === 'string' ? config.keyHash : '';
  const deadline = typeof config.expiresAt === 'string' ? Date.parse(config.expiresAt) : NaN;
  const active = () => enabled && /^[a-f0-9]{64}$/.test(keyHash) && Number.isFinite(deadline) && deadline > Date.now();
  function accepts(key) {
    return active() && typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key) && C.equal(C.sha(key), keyHash);
  }
  function principal(row, raw) {
    return { id: row.id, username: 'development-admin', display_name: 'Development Admin',
      role: 'owner', status: 'active', development: true, authentication_method: 'development-link',
      must_change_password: false, mfa_enabled: false, mfa_verified: false,
      session_id: row.id, expires_at: row.expires_at, last_seen: row.last_seen,
      development_expires_at: new Date(deadline).toISOString(), raw };
  }
  async function init(db) {
    await db.query(ddl);
    if (active()) {
      await db.query('DELETE FROM gameops_development_sessions WHERE expires_at<=now() OR key_fingerprint<>$1', [keyHash]);
    } else {
      await db.query('DELETE FROM gameops_development_sessions');
    }
  }
  async function issue(db, req) {
    if (!active()) throw new Error('Development access is unavailable');
    const raw = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Math.min(Date.now() + SESSION_MS, deadline)).toISOString();
    const q = await db.query(`INSERT INTO gameops_development_sessions(token_hash,key_fingerprint,expires_at,ip,user_agent)
      VALUES($1,$2,$3,$4,$5) RETURNING id,expires_at,last_seen`,
    [C.sha(raw), keyHash, expiresAt, String(req.ip || '').slice(0, 64), String(req.get('User-Agent') || '').slice(0, 300)]);
    return principal(q.rows[0], raw);
  }
  async function session(raw) {
    if (!active()) return null;
    const q = await pool.query(`SELECT id,expires_at,last_seen FROM gameops_development_sessions
      WHERE token_hash=$1 AND key_fingerprint=$2 AND expires_at>now()`, [C.sha(raw), keyHash]);
    if (!q.rowCount) return null;
    await pool.query("UPDATE gameops_development_sessions SET last_seen=now() WHERE id=$1 AND last_seen<now()-interval '1 minute'", [q.rows[0].id]);
    return principal(q.rows[0], raw);
  }
  return { active, accepts, init, issue, session };
}
module.exports = { createDevelopmentAccess };
