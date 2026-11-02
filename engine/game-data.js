'use strict';
// A read-only projection directly over signed bridge rows. Legacy and staging
// data are never blended into production totals or written into wallet tables.
const {RequestError}=require('./transaction');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID=/^[1-9][0-9]{0,17}$/;
const games=['skygate-5000','uno-luck','mahjong-wild'];
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function filters(q){
 const environment=q.environment===undefined?'production':q.environment;
 const game=q.game===undefined?'all':q.game;
 if(typeof environment!=='string'||!['production','staging'].includes(environment)||typeof game!=='string'||!(game==='all'||games.includes(game)))throw new RequestError(400,'Invalid game data scope');
 const before=q.before===undefined?null:q.before,limit=q.limit===undefined?25:Number(q.limit);
 if((before!==null&&(typeof before!=='string'||!ID.test(before)))||!Number.isInteger(limit)||limit<1||limit>100)throw new RequestError(400,'Invalid data cursor/limit');
 const result=q.result===undefined?'all':q.result;
 const term=q.q===undefined?'':q.q;
 const player=q.player===undefined?null:q.player;
 if(typeof result!=='string'||!['all','win','loss','draw'].includes(result)||typeof term!=='string'||term.length>80||(player!==null&&(typeof player!=='string'||!UUID.test(player))))throw new RequestError(400,'Invalid data filter');
 return {environment,game,before,limit,result,q:term.trim(),player};
}
const BASE=' FROM gameops_bridge_rounds r JOIN gameops_games g ON g.id=r.game_id JOIN gameops_observed_players p ON p.game_id=r.game_id AND p.environment=r.environment AND p.player_ref=r.player_ref ';
const SCOPE=" r.environment=$1 AND ($2='all' OR g.slug=$2) ";
const RESULT=" CASE WHEN r.payout>r.stake THEN 'win' WHEN r.payout<r.stake THEN 'loss' ELSE 'draw' END ";
const COLUMNS=`r.id::text,r.source_event_id,r.source_round_id,p.id::text AS player_id,r.player_ref,g.name AS game,g.slug,r.environment,r.currency,r.stake::text,r.payout::text,(r.payout-r.stake)::text AS net_return,r.occurred_at,r.received_at,r.stream_id::text,r.source_sequence::text,${RESULT} AS result`;
function scopeMeta(f){return {environment:f.environment,game:f.game,currency:'DEMO_COIN',source:'signed_bridge_observations',externalWalletConnected:false,legacyIncluded:false,amountsAreDecimalStrings:true};}
function maskPlayer(req,row){if(req.auth.role!=='viewer')return row;const {player_ref,player_id,...visible}=row;return visible;}
function mount(app,{pool}){
 app.get('/api/admin/data/summary',wrap(async(req,res)=>{
  const f=filters(req.query),db=await pool.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const totals=await db.query(`SELECT count(*)::text AS rounds,count(DISTINCT p.id)::text AS players,coalesce(sum(r.stake),0)::numeric(50,12)::text AS stake,coalesce(sum(r.payout),0)::numeric(50,12)::text AS payout,(coalesce(sum(r.payout),0)-coalesce(sum(r.stake),0))::numeric(50,12)::text AS player_net_return,max(r.received_at) AS last_received_at ${BASE} WHERE ${SCOPE}`,[f.environment,f.game]);
   const grouped=await db.query(`SELECT g.slug,g.name,r.environment,count(*)::text AS rounds,count(DISTINCT p.id)::text AS players,sum(r.stake)::text AS stake,sum(r.payout)::text AS payout,max(r.received_at) AS last_received_at ${BASE} WHERE ${SCOPE} GROUP BY g.slug,g.name,r.environment ORDER BY g.slug`,[f.environment,f.game]);
   const legacy=await db.query('SELECT count(*)::text AS records FROM gameops_events');
   await db.query('COMMIT');
   res.json({...scopeMeta(f),...totals.rows[0],games:grouped.rows,legacy:{records:legacy.rows[0].records,included:false},as_of:new Date().toISOString(),note:'Observed server events only; not cash balances or proof of complete source history. Reconciliation verifies a declared prefix.'});
  }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
 }));
 app.get('/api/admin/data/rounds',wrap(async(req,res)=>{
  const f=filters(req.query);
  const q=await pool.query(`SELECT ${COLUMNS} ${BASE} WHERE ${SCOPE} AND ($3::bigint IS NULL OR r.id<$3) AND ($4::uuid IS NULL OR p.id=$4) AND ($5='all' OR (${RESULT})=$5) AND ($6='' OR position(lower($6) IN lower(r.source_event_id))>0 OR position(lower($6) IN lower(r.source_round_id))>0) ORDER BY r.id DESC LIMIT $7`,[f.environment,f.game,f.before,f.player,f.result,f.q,f.limit+1]);
  const hasMore=q.rows.length>f.limit,rows=q.rows.slice(0,f.limit).map(x=>maskPlayer(req,x));
  res.json({...scopeMeta(f),items:rows,next_cursor:hasMore?rows.at(-1).id:null,readOnly:true});
 }));
 app.get('/api/admin/data/rounds/:id',wrap(async(req,res)=>{
  const f=filters(req.query);if(!ID.test(req.params.id))throw new RequestError(400,'Invalid observed round ID');
  const q=await pool.query(`SELECT ${COLUMNS},r.payload_hash,r.key_id ${BASE} WHERE ${SCOPE} AND r.id=$3`,[f.environment,f.game,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Round not found in selected environment');
  res.json({...scopeMeta(f),item:maskPlayer(req,q.rows[0]),immutable:true});
 }));
 app.get('/api/admin/data/players',wrap(async(req,res)=>{
  const f=filters(req.query),q=await pool.query(`SELECT p.id::text,p.player_ref,g.slug,g.name AS game,p.environment,count(*)::text AS rounds,sum(r.stake)::text AS stake,sum(r.payout)::text AS payout,(sum(r.payout)-sum(r.stake))::text AS net_return,max(r.occurred_at) AS last_seen ${BASE} WHERE ${SCOPE} GROUP BY p.id,g.slug,g.name ORDER BY max(r.id) DESC LIMIT 100`,[f.environment,f.game]);
  res.json({...scopeMeta(f),items:q.rows,limit:100,identityProviderConnected:false,note:'Pseudonymous source player references, not verified personal identities or wallet balances.'});
 }));
 app.get('/api/admin/data/players/:id',wrap(async(req,res)=>{
  const f=filters(req.query);if(!UUID.test(req.params.id))throw new RequestError(400,'Invalid observed player ID');
  const q=await pool.query(`SELECT p.id::text,p.player_ref,g.slug,g.name AS game,p.environment,count(*)::text AS rounds,sum(r.stake)::text AS stake,sum(r.payout)::text AS payout,(sum(r.payout)-sum(r.stake))::text AS net_return,max(r.occurred_at) AS last_seen ${BASE} WHERE ${SCOPE} AND p.id=$3 GROUP BY p.id,g.slug,g.name`,[f.environment,f.game,req.params.id]);
  if(!q.rowCount)throw new RequestError(404,'Player not found in selected environment');
  res.json({...scopeMeta(f),item:q.rows[0],balance:null,identityVerified:false,impersonationAllowed:false});
 }));
 app.get('/api/admin/data/reconciliations',wrap(async(req,res)=>{
  const f=filters(req.query);
  const q=await pool.query(`SELECT DISTINCT ON (s.game_id,s.environment,s.stream_id) s.id::text,g.name AS game,g.slug,s.environment,s.stream_id::text,s.through_sequence::text,s.expected_count::text,s.received_count::text,s.expected_stake::text,s.received_stake::text,s.expected_payout::text,s.received_payout::text,s.expected_manifest,s.received_manifest,s.status,s.checks,s.checked_at,s.source_checked_at,(SELECT count(*)::text FROM gameops_bridge_rounds r WHERE r.game_id=s.game_id AND r.environment=s.environment AND r.stream_id=s.stream_id AND r.source_sequence>s.through_sequence) AS after_watermark FROM gameops_stream_reconciliations s JOIN gameops_games g ON g.id=s.game_id WHERE s.environment=$1 AND ($2='all' OR g.slug=$2) ORDER BY s.game_id,s.environment,s.stream_id,s.through_sequence DESC,s.checked_at DESC LIMIT 100`,[f.environment,f.game]);
  res.json({...scopeMeta(f),items:q.rows.map(x=>({...x,verification_state:x.status==='mismatch'?'mismatch':x.status==='empty'?'empty':Date.now()-Date.parse(x.checked_at)>180000?'stale':x.after_watermark!=='0'?'new_events_pending':'prefix_matched'})),note:'Count, exact totals and source manifest are checked through the declared sequence. This is not financial settlement or external balance verification.'});
 }));
}
module.exports={filters,mount};
