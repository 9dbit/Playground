'use strict';
// Signed source observations, never wallet writes or game-control commands.
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEQ = /^(0|[1-9][0-9]{0,14})$/;
const HASH = /^[0-9a-f]{64}$/;
const DDL = `
ALTER TABLE gameops_bridge_rounds ADD COLUMN IF NOT EXISTS stream_id uuid;
ALTER TABLE gameops_bridge_rounds ADD COLUMN IF NOT EXISTS source_sequence bigint;
CREATE UNIQUE INDEX IF NOT EXISTS gameops_bridge_stream_sequence_idx ON gameops_bridge_rounds(game_id,environment,stream_id,source_sequence) WHERE stream_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gameops_bridge_env_time_idx ON gameops_bridge_rounds(environment,game_id,occurred_at,id);
CREATE INDEX IF NOT EXISTS gameops_bridge_player_scope_idx ON gameops_bridge_rounds(environment,game_id,player_ref,id DESC);
CREATE TABLE IF NOT EXISTS gameops_observed_players(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid NOT NULL REFERENCES gameops_games(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 player_ref text NOT NULL,last_seen timestamptz NOT NULL DEFAULT now(),
 UNIQUE(game_id,environment,player_ref)
);
CREATE TABLE IF NOT EXISTS gameops_stream_reconciliations(
 id bigserial PRIMARY KEY,game_id uuid NOT NULL REFERENCES gameops_games(id),environment text NOT NULL,
 stream_id uuid NOT NULL,through_sequence bigint NOT NULL,expected_count bigint NOT NULL,
 expected_stake numeric(50,12) NOT NULL,expected_payout numeric(50,12) NOT NULL,expected_manifest text NOT NULL,
 received_count bigint NOT NULL,received_stake numeric(50,12) NOT NULL,received_payout numeric(50,12) NOT NULL,received_manifest text NOT NULL,
 status text NOT NULL CHECK(status IN ('matched','mismatch','empty')),checks integer NOT NULL DEFAULT 1,
 checked_at timestamptz NOT NULL DEFAULT now(),source_checked_at timestamptz NOT NULL,key_id text NOT NULL,
 UNIQUE(game_id,environment,stream_id,through_sequence)
);
CREATE INDEX IF NOT EXISTS gameops_reconciliation_scope_idx ON gameops_stream_reconciliations(environment,game_id,checked_at DESC);
`;
async function init(pool) {
 await pool.query(DDL);
 await pool.query('INSERT INTO gameops_observed_players(game_id,environment,player_ref,last_seen) SELECT game_id,environment,player_ref,max(occurred_at) FROM gameops_bridge_rounds GROUP BY game_id,environment,player_ref ON CONFLICT(game_id,environment,player_ref) DO NOTHING');
}
function streamFields(value, ErrorType) {
 if (value.stream_id === undefined && value.source_sequence === undefined) return {};
 if (!UUID.test(value.stream_id || '') || typeof value.source_sequence !== 'string' || !SEQ.test(value.source_sequence) || BigInt(value.source_sequence) < 1n) throw new ErrorType(400,'INVALID_SOURCE_SEQUENCE');
 return {stream_id:value.stream_id,source_sequence:value.source_sequence};
}
function snapshot(value, key, decimal, ErrorType, now=Date.now()) {
 if (!key.allowRounds) throw new ErrorType(403,'ROUND_INGESTION_DISABLED');
 const fields=['schema_version','game','environment','type','stream_id','through_sequence','expected_count','stake','payout','manifest_hash','occurred_at'];
 if (Object.keys(value).some(x=>!fields.includes(x)) || !UUID.test(value.stream_id||'') ||
     typeof value.through_sequence!=='string' || !SEQ.test(value.through_sequence) ||
     typeof value.expected_count!=='string' || !SEQ.test(value.expected_count) ||
     value.expected_count!==value.through_sequence || !HASH.test(value.manifest_hash||'') ||
     typeof value.occurred_at!=='string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.occurred_at) ||
     !Number.isFinite(Date.parse(value.occurred_at)) || Math.abs(now-Date.parse(value.occurred_at))>300000)
   throw new ErrorType(400,'INVALID_RECONCILIATION');
 return {type:'source.reconcile',stream_id:value.stream_id,through_sequence:value.through_sequence,
  expected_count:value.expected_count,stake:decimal(value.stake),payout:decimal(value.payout),
  manifest_hash:value.manifest_hash,occurred_at:new Date(value.occurred_at).toISOString()};
}
function manifestLine(row) {
 return [String(row.source_sequence),row.source_event_id,row.source_round_id,row.player_ref,
  row.stake,row.payout,new Date(row.occurred_at).toISOString()].join('\t')+'\n';
}
// Game-row serialization in the caller makes this prefix stable. Keyset pages
// bound memory; no external I/O runs inside the SQL transaction.
async function reconcile(db,gid,key,event,ErrorType) {
 await db.query("SET LOCAL statement_timeout = '8s'");
 const args=[gid,key.environment,event.stream_id,event.through_sequence];
 const old=await db.query('SELECT expected_count::text,expected_stake::text,expected_payout::text,expected_manifest FROM gameops_stream_reconciliations WHERE game_id=$1 AND environment=$2 AND stream_id=$3 AND through_sequence=$4',args);
 if(old.rowCount){const x=old.rows[0];if(x.expected_count!==event.expected_count||x.expected_stake!==event.stake||x.expected_payout!==event.payout||x.expected_manifest!==event.manifest_hash)throw new ErrorType(409,'RECONCILIATION_CONFLICT');}
 const totals=await db.query('SELECT count(*)::text AS count,coalesce(sum(stake),0)::numeric(50,12)::text AS stake,coalesce(sum(payout),0)::numeric(50,12)::text AS payout,min(source_sequence)::text AS first,max(source_sequence)::text AS last FROM gameops_bridge_rounds WHERE game_id=$1 AND environment=$2 AND stream_id=$3 AND source_sequence<=$4',args);
 const t=totals.rows[0],hash=crypto.createHash('sha256');let after='0';
 for(;;){
  const page=await db.query('SELECT source_sequence::text,source_event_id,source_round_id,player_ref,stake::text,payout::text,occurred_at FROM gameops_bridge_rounds WHERE game_id=$1 AND environment=$2 AND stream_id=$3 AND source_sequence<=$4 AND source_sequence>$5 ORDER BY source_sequence LIMIT 1000',[...args,after]);
  for(const row of page.rows)hash.update(manifestLine(row));
  if(page.rowCount<1000)break;after=page.rows.at(-1).source_sequence;
 }
 const actual=hash.digest('hex');
 const matched=t.count===event.expected_count&&t.stake===event.stake&&t.payout===event.payout&&actual===event.manifest_hash&&
  (event.expected_count==='0'||(t.first==='1'&&t.last===event.through_sequence));
 const status=matched?(t.count==='0'?'empty':'matched'):'mismatch';
 const q=await db.query(`INSERT INTO gameops_stream_reconciliations(game_id,environment,stream_id,through_sequence,expected_count,expected_stake,expected_payout,expected_manifest,received_count,received_stake,received_payout,received_manifest,status,source_checked_at,key_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
 ON CONFLICT(game_id,environment,stream_id,through_sequence) DO UPDATE SET received_count=EXCLUDED.received_count,received_stake=EXCLUDED.received_stake,received_payout=EXCLUDED.received_payout,received_manifest=EXCLUDED.received_manifest,status=EXCLUDED.status,checks=gameops_stream_reconciliations.checks+1,checked_at=now(),source_checked_at=EXCLUDED.source_checked_at,key_id=EXCLUDED.key_id RETURNING id::text`,
 [...args,event.expected_count,event.stake,event.payout,event.manifest_hash,t.count,t.stake,t.payout,actual,status,event.occurred_at,key.id]);
 return {accepted:true,type:'source.reconcile',game:key.game,environment:key.environment,stream_id:event.stream_id,
  through_sequence:event.through_sequence,reconciliation_id:q.rows[0].id,status,
  received_count:t.count,received_stake:t.stake,received_payout:t.payout,manifest_hash:actual};
}
module.exports={init,streamFields,snapshot,reconcile,manifestLine};
