'use strict';
// CP14: a write and its audit record must commit (or roll back) together.
class RequestError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') {
    super(message); this.status = status; this.code = code;
  }
}
async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve original error. */ }
    throw error;
  } finally { client.release(); }
}
module.exports = { transaction, RequestError };
