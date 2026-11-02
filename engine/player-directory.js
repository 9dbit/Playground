'use strict';
const { HttpError, withTransaction } = require('./database-unit');
const STATES = { all: 'all', active: 'active', banned: 'blocked_locally', review: 'review' };
function pageNumber(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^[1-9][0-9]*$/.test(String(value))) return null;
  const n = Number(value); return Number.isSafeInteger(n) && n <= maximum ? n : null;
}
function parsePlayerQuery(query = {}) {
  const state = query.state === undefined ? 'all' : query.state;
  const page = pageNumber(query.page, 1, 10000), limit = pageNumber(query.limit, 25, 100);
  const q = query.q === undefined ? '' : query.q;
  if (typeof state !== 'string' || !Object.hasOwn(STATES, state) || !page || !limit || typeof q !== 'string' || q.length > 80) {
    throw new HttpError(400, 'Invalid player state, search or pagination', 'INVALID_PLAYER_FILTER');
  }
  return { state, page, limit, q: q.trim() };
}
async function readPlayers(pool, query = {}) {
  const filter = parsePlayerQuery(query);
  return withTransaction(pool, async db => {
    const from = ' FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id LEFT JOIN gameops_player_profiles m ON m.player_id=p.id ';
    const where = " WHERE ($1='all' OR coalesce(m.local_status,'active')=$1) AND ($2='' OR position(lower($2) IN lower(p.player_ref))>0 OR position(lower($2) IN lower(coalesce(m.first_name,'')||' '||coalesce(m.last_name,'')))>0)";
    const args = [STATES[filter.state], filter.q];
    const count = await db.query('SELECT count(*)::int AS total' + from + where, args);
    const rows = await db.query("SELECT p.id,p.player_ref,p.game_id,g.name AS game,p.rounds::text,p.last_seen,coalesce(m.first_name,'') AS first_name,coalesce(m.last_name,'') AS last_name,coalesce(m.local_status,'active') AS local_status" + from + where + ' ORDER BY p.last_seen DESC,p.id DESC LIMIT $3 OFFSET $4',
      [...args, filter.limit, (filter.page - 1) * filter.limit]);
    const total = count.rows[0].total, pages = Math.ceil(total / filter.limit);
    return { items: rows.rows, total, pages, page: filter.page, limit: filter.limit, hasNext: filter.page < pages,
      filters: { state: filter.state, q: filter.q }, externalBlockEnforced: false,
      note: 'Filtered in PostgreSQL before pagination. Local blocking is not enforced by external games.' };
  }, { readOnly: true });
}
module.exports = { parsePlayerQuery, readPlayers };
