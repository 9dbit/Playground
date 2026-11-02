'use strict';
// A business write and its audit event must use this SAME connection and commit.
class HttpError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST', details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
async function withTransaction(pool, work, { readOnly = false } = {}) {
  const db = await pool.connect();
  let begun = false;
  try {
    await db.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    begun = true;
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const result = await work(db);
    await db.query('COMMIT'); begun = false;
    return result;
  } catch (error) {
    if (begun) { try { await db.query('ROLLBACK'); } catch { /* preserve original failure */ } }
    throw error;
  } finally { db.release(); }
}
async function writeAudit(db, actor, action, resource, details = {}) {
  await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',
    [actor, action, String(resource), JSON.stringify(details)]);
}
module.exports = { HttpError, withTransaction, writeAudit };
