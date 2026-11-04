'use strict';
const crypto = require('node:crypto');
const C = require('./security-crypto');
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

// Called inside security.init's transaction and bootstrap advisory lock.
// Only the original bootstrap owner can be managed by service configuration.
async function syncRuntimeCredentials(db, { enabled, username, password, master, revision = '' }) {
  if (!enabled) return 'disabled';
  username = String(username || '').trim().toLowerCase();
  if (!USERNAME.test(username) || !C.passwordValid(password)) {
    throw new Error('ADMIN_CREDENTIALS_SYNC requires a valid ADMIN_USERNAME and an ADMIN_PASSWORD of 15–128 characters');
  }
  if (typeof revision !== 'string' || revision.length > 128) throw new Error('ADMIN_CREDENTIALS_REVISION must be at most 128 characters');
  const fingerprint = crypto.createHmac('sha256', master)
    .update(JSON.stringify(['runtime-credentials-v1', username, password, revision])).digest('hex');
  const saved = (await db.query('SELECT * FROM gameops_runtime_credentials WHERE singleton=true FOR UPDATE')).rows[0];
  if (saved && C.equal(saved.fingerprint, fingerprint)) return 'unchanged';

  let accountId = saved?.admin_id;
  if (!accountId) {
    const original = await db.query(`SELECT DISTINCT a.id FROM gameops_admin_accounts a
      JOIN gameops_audit log ON log.resource=a.id::text
      WHERE log.action='security.bootstrap.completed' AND log.actor='system'`);
    if (original.rows.length !== 1) throw new Error('Runtime credentials require one verified bootstrap account; no account was changed');
    accountId = original.rows[0].id;
  }
  const account = (await db.query('SELECT * FROM gameops_admin_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
  if (!account || account.role !== 'owner' || account.status !== 'active') {
    throw new Error('Runtime credentials cannot modify a missing, disabled or non-owner bootstrap account');
  }
  const conflict = await db.query('SELECT id FROM gameops_admin_accounts WHERE username=$1 AND id<>$2', [username, accountId]);
  if (conflict.rowCount) throw new Error('ADMIN_USERNAME is already used by another account; no account was changed');

  const hash = await C.passwordHash(password);
  await db.query(`UPDATE gameops_admin_accounts SET username=$2,password_hash=$3,must_change_password=false,
    auth_version=auth_version+1,mfa_pending=null,mfa_pending_until=null,mfa_pending_session=null,updated_at=now()
    WHERE id=$1`, [accountId, username, hash]);
  await db.query('DELETE FROM gameops_admin_sessions WHERE admin_id=$1', [accountId]);
  await db.query('DELETE FROM gameops_auth_buckets WHERE key=ANY($1::text[])', [
    [...new Set([account.username, username])].map(name => C.sha('login-user:' + name)),
  ]);
  // Check the persisted hash without disclosing credentials or creating a login session.
  const stored = (await db.query('SELECT username,password_hash FROM gameops_admin_accounts WHERE id=$1', [accountId])).rows[0];
  if (stored.username !== username || !await C.passwordVerify(password, stored.password_hash)) {
    throw new Error('Runtime credential verification failed; transaction rolled back');
  }
  await db.query(`INSERT INTO gameops_runtime_credentials(singleton,admin_id,fingerprint) VALUES(true,$1,$2)
    ON CONFLICT(singleton) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,updated_at=now()`, [accountId, fingerprint]);
  await db.query(`INSERT INTO gameops_audit(actor,action,resource,details) VALUES('system','security.runtime_credentials.synced',$1,$2)`,
    [accountId, JSON.stringify({ usernameChanged: account.username !== username, sessionsRevoked: true, mfaPreserved: true, credentialVerified: true })]);
  return 'applied_verified';
}

module.exports = { syncRuntimeCredentials };
