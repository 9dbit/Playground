'use strict';
const { transaction, RequestError } = require('./transaction');
function parsePlayers(query = {}) {
  const state = query.state === undefined ? 'all' : query.state;
  const q = query.q === undefined ? '' : query.q;
  const validInt = (v, fallback, max) => v === undefined ? fallback : typeof v === 'string' && /^[1-9][0-9]*$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) <= max ? Number(v) : null;
  const page = validInt(query.page, 1, 10000), limit = validInt(query.limit, 25, 100);
  if (!['all', 'active', 'banned', 'review'].includes(state) || typeof q !== 'string' || q.length > 80 || page === null || limit === null) throw new RequestError(400, 'Invalid player state, query or pagination', 'INVALID_PLAYER_FILTER');
  return { state, q: q.trim(), page, limit };
}
async function readPlayers(pool, query) {
  const f = parsePlayers(query);
  const from = ' FROM gameops_players p JOIN gameops_games g ON g.id=p.game_id LEFT JOIN gameops_player_profiles m ON m.player_id=p.id ';
  const where = " WHERE ($1='all' OR coalesce(m.local_status,'active')=CASE WHEN $1='banned' THEN 'blocked_locally' ELSE $1 END) AND ($2='' OR position(lower($2) in lower(p.player_ref))>0 OR position(lower($2) in lower(coalesce(m.first_name,'')||' '||coalesce(m.last_name,'')))>0)";
  return transaction(pool, async db => {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const count = await db.query('SELECT count(*)::int AS total' + from + where, [f.state, f.q]);
    const rows = await db.query("SELECT p.id,p.player_ref,p.game_id,g.name AS game,p.rounds::text,p.last_seen,coalesce(m.first_name,'') AS first_name,coalesce(m.last_name,'') AS last_name,coalesce(m.local_status,'active') AS local_status" + from + where + ' ORDER BY p.last_seen DESC,p.id DESC LIMIT $3 OFFSET $4', [f.state, f.q, f.limit, (f.page-1)*f.limit]);
    const total = count.rows[0].total;
    return { items: rows.rows, total, page: f.page, limit: f.limit, pages: Math.ceil(total/f.limit), hasNext: f.page*f.limit < total,
      filters: {state:f.state,q:f.q}, externalBanEnforced:false, note:'Local status only; no ban is enforced at external games.' };
  });
}
module.exports = { parsePlayers, readPlayers };
