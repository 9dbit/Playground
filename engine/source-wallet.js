'use strict';
// The game is the balance authority. These tables contain signed observations,
// requests and confirmed command results, never a second spendable wallet.
const crypto=require('node:crypto');
const P=require('./source-wallet-protocol');
const {transaction,RequestError}=require('./transaction');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const DDL=`
CREATE TABLE IF NOT EXISTS gameops_source_wallet_streams(
 game_id uuid NOT NULL REFERENCES gameops_games(id),environment text NOT NULL CHECK(environment IN ('staging','production')),
 stream_id uuid NOT NULL,key_id text NOT NULL,coverage_started_at timestamptz,
 through_sequence bigint NOT NULL DEFAULT 0,expected_count bigint NOT NULL DEFAULT 0,received_count bigint NOT NULL DEFAULT 0,
 source_commands_enabled boolean NOT NULL DEFAULT false,status text NOT NULL DEFAULT 'unverified',checks jsonb NOT NULL DEFAULT '{}',snapshot_hash text,
 source_checked_at timestamptz,checked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(game_id,environment,stream_id));
CREATE TABLE IF NOT EXISTS gameops_source_players(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid NOT NULL,environment text NOT NULL,stream_id uuid NOT NULL,
 player_ref text NOT NULL,balance bigint NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND 1000000),
 revision bigint NOT NULL DEFAULT 0,latest_sequence bigint NOT NULL DEFAULT 0,
 source_observed_at timestamptz,received_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(game_id,environment,stream_id) REFERENCES gameops_source_wallet_streams(game_id,environment,stream_id),
 UNIQUE(game_id,environment,stream_id,player_ref));
CREATE TABLE IF NOT EXISTS gameops_source_wallet_entries(
 id bigserial PRIMARY KEY,game_id uuid NOT NULL,environment text NOT NULL,stream_id uuid NOT NULL,
 source_player_id uuid NOT NULL REFERENCES gameops_source_players(id),source_sequence bigint NOT NULL CHECK(source_sequence BETWEEN 1 AND 100000),
 player_sequence bigint NOT NULL CHECK(player_sequence BETWEEN 1 AND 100000),ledger_ref text NOT NULL,kind text NOT NULL,
 delta bigint NOT NULL CHECK(delta BETWEEN -1000000 AND 1000000),balance_after bigint NOT NULL CHECK(balance_after BETWEEN 0 AND 1000000),
 occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),command_id uuid,payload_hash text NOT NULL,
 UNIQUE(game_id,environment,stream_id,source_sequence),UNIQUE(game_id,environment,stream_id,ledger_ref),UNIQUE(source_player_id,player_sequence));
CREATE INDEX IF NOT EXISTS source_wallet_entries_player_idx ON gameops_source_wallet_entries(source_player_id,player_sequence DESC);
CREATE TABLE IF NOT EXISTS gameops_source_wallet_nonces(key_id text NOT NULL,nonce text NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(key_id,nonce));
CREATE INDEX IF NOT EXISTS source_wallet_nonces_expiry_idx ON gameops_source_wallet_nonces(expires_at);
CREATE TABLE IF NOT EXISTS gameops_source_wallet_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),source_player_id uuid NOT NULL REFERENCES gameops_source_players(id),
 idempotency_key uuid NOT NULL UNIQUE,payload_hash text NOT NULL,
 action text NOT NULL CHECK(action IN ('credit','debit')),amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 1000000),reason text NOT NULL,
 requested_by text NOT NULL,review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
 reviewed_by text,review_note text,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz);
CREATE INDEX IF NOT EXISTS source_wallet_requests_player_idx ON gameops_source_wallet_requests(source_player_id,created_at DESC);
CREATE TABLE IF NOT EXISTS gameops_source_wallet_commands(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL UNIQUE REFERENCES gameops_source_wallet_requests(id),
 source_player_id uuid NOT NULL REFERENCES gameops_source_players(id),expected_revision bigint NOT NULL,
 action text NOT NULL CHECK(action IN ('credit','debit')),amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 1000000),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','delivered','applied','rejected')),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),last_delivered_at timestamptz,
 delivery_attempts integer NOT NULL DEFAULT 0,result jsonb,result_hash text,finished_at timestamptz);
CREATE INDEX IF NOT EXISTS source_wallet_commands_pending_idx ON gameops_source_wallet_commands(source_player_id,created_at) WHERE status IN ('queued','delivered');
`;
const scope=q=>{
 const environment=q.environment??'production',game=q.game??'all';
 if(typeof environment!=='string'||!['production','staging'].includes(environment)||typeof game!=='string'||!['all','uno-luck','skygate-5000','mahjong-wild'].includes(game))P.bad('INVALID_WALLET_SCOPE');
 return {environment,game};
};
const scopeSql="p.environment=$1 AND ($2='all' OR g.slug=$2)";
const joined=` FROM gameops_source_players p JOIN gameops_games g ON g.id=p.game_id JOIN gameops_source_wallet_streams s ON s.game_id=p.game_id AND s.environment=p.environment AND s.stream_id=p.stream_id `;
const playerCols=`p.id::text,p.game_id::text,p.environment,p.stream_id::text,p.player_ref,p.balance::text,p.revision::text,p.latest_sequence::text,p.source_observed_at,p.received_at,g.slug,g.name AS game,s.coverage_started_at,s.source_commands_enabled,s.through_sequence::text,s.status AS reconciliation,s.checks,s.source_checked_at,s.checked_at,(SELECT coalesce(max(source_sequence),0)::text FROM gameops_source_wallet_entries z WHERE z.game_id=p.game_id AND z.environment=p.environment AND z.stream_id=p.stream_id) AS received_through`;
function verification(r){
 if(r.reconciliation==='mismatch')return 'mismatch';
 if(!r.checked_at)return 'unverified';
 if(Date.now()-Date.parse(r.source_checked_at)>180000)return 'stale';
 if(BigInt(r.received_through)>BigInt(r.through_sequence))return 'new_events_pending';
 return r.reconciliation==='matched'?'matched':r.reconciliation==='empty'?'empty':'unverified';
}
async function audit(db,actor,action,resource,details={}){await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',[actor,action,resource,JSON.stringify(details)]);}
function requestState(r){return r.review_status==='pending'?'pending_approval':r.review_status==='rejected'?'rejected_by_admin':r.command_status==='applied'?'applied':r.command_status==='rejected'?'rejected_by_source':r.command_status==='delivered'?'awaiting_source_confirmation':'queued';}
function createSourceWallet({pool,rawConfig=process.env.GAMEOPS_WALLET_KEYS,logger=console}){
 const keys=P.configuration(rawConfig);
 const keyFor=row=>keys.find(k=>k.enabled&&k.game===row.slug&&k.environment===row.environment&&k.streamId===row.stream_id);
 const decorate=row=>({...row,verification:verification(row),commands_available:!!keyFor(row)?.allowCommands&&row.source_commands_enabled&&row.environment==='staging'&&verification(row)==='matched',
  authority:'game_server',currency:'DEMO_COIN',cash_value:false,identity_verified:false,externalAccountIdExposed:false});
 async function init(){await pool.query(DDL);}
 async function lockStream(db,key){
  const g=await db.query('SELECT id FROM gameops_games WHERE slug=$1',[key.game]);if(!g.rowCount)P.bad('GAME_NOT_REGISTERED',409);
  const gid=g.rows[0].id;
  await db.query('INSERT INTO gameops_source_wallet_streams(game_id,environment,stream_id,key_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[gid,key.environment,key.streamId,key.id]);
  const s=await db.query('SELECT * FROM gameops_source_wallet_streams WHERE game_id=$1 AND environment=$2 AND stream_id=$3 FOR UPDATE',[gid,key.environment,key.streamId]);
  return {gid,stream:s.rows[0]};
 }
 async function acceptEvents(db,key,gid,message){
  let inserted=0;
  for(const e of message.events){
   const p=(await db.query(`INSERT INTO gameops_source_players(game_id,environment,stream_id,player_ref) VALUES($1,$2,$3,$4)
     ON CONFLICT(game_id,environment,stream_id,player_ref) DO UPDATE SET player_ref=EXCLUDED.player_ref RETURNING id`,[gid,key.environment,key.streamId,e.player_ref])).rows[0];
   const fingerprint=P.hash(P.manifestLine(e));
   const old=await db.query(`SELECT id,payload_hash FROM gameops_source_wallet_entries WHERE (game_id=$1 AND environment=$2 AND stream_id=$3 AND (source_sequence=$4 OR ledger_ref=$5)) OR (source_player_id=$6 AND player_sequence=$7)`,[gid,key.environment,key.streamId,e.sequence,e.ledger_ref,p.id,e.player_sequence]);
   if(old.rowCount){if(old.rowCount!==1||old.rows[0].payload_hash!==fingerprint)P.bad('WALLET_EVENT_CONFLICT',409);continue;}
   if(e.command_id){
    const command=await db.query('SELECT * FROM gameops_source_wallet_commands WHERE id=$1 AND source_player_id=$2',[e.command_id,p.id]);
    if(!command.rowCount||command.rows[0].action!==(e.kind==='admin_credit'?'credit':'debit')||BigInt(command.rows[0].amount)!==(BigInt(e.delta)<0n?-BigInt(e.delta):BigInt(e.delta)))P.bad('UNKNOWN_OR_CONFLICTING_SOURCE_COMMAND',409);
   }
   await db.query(`INSERT INTO gameops_source_wallet_entries(game_id,environment,stream_id,source_player_id,source_sequence,player_sequence,ledger_ref,kind,delta,balance_after,occurred_at,command_id,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[gid,key.environment,key.streamId,p.id,e.sequence,e.player_sequence,e.ledger_ref,e.kind,e.delta,e.balance_after,e.occurred_at,e.command_id,fingerprint]);
   await db.query('UPDATE gameops_source_players SET balance=$2,revision=$3,latest_sequence=$4,source_observed_at=$5,received_at=now() WHERE id=$1 AND revision<$3',[p.id,e.balance_after,e.player_sequence,e.sequence,e.occurred_at]);inserted++;
  }
  return {through_sequence:message.events.at(-1).sequence,inserted};
 }
 async function reconcile(db,key,gid,m,existing){
  const rows=(await db.query(`SELECT e.source_sequence::text AS sequence,e.player_sequence::text,p.player_ref,e.ledger_ref,e.kind,e.delta::text,e.balance_after::text,e.occurred_at,e.command_id::text FROM gameops_source_wallet_entries e JOIN gameops_source_players p ON p.id=e.source_player_id WHERE e.game_id=$1 AND e.environment=$2 AND e.stream_id=$3 AND e.source_sequence<=$4 ORDER BY e.source_sequence`,[gid,key.environment,key.streamId,m.through_sequence])).rows;
  const fingerprint=P.hash(JSON.stringify([m.through_sequence,m.expected_count,m.total_balance,m.player_count,m.manifest_hash,m.balances_hash,m.coverage_started_at]));
  if(existing.snapshot_hash && String(existing.through_sequence)===m.through_sequence&&existing.snapshot_hash!==fingerprint)P.bad('WALLET_SNAPSHOT_CONFLICT',409);
  if(BigInt(existing.through_sequence)>BigInt(m.through_sequence))P.bad('WALLET_OLD_WATERMARK',409);
  const seen=new Map(),manifest=crypto.createHash('sha256');let contiguous=true,chain=true,i=0;
  for(const raw of rows){const e={...raw,occurred_at:new Date(raw.occurred_at).toISOString()};i++;if(BigInt(e.sequence)!==BigInt(i))contiguous=false;
   const prev=seen.get(e.player_ref)||{balance:0n,revision:0n};
   if(BigInt(e.player_sequence)!==prev.revision+1n||prev.balance+BigInt(e.delta)!==BigInt(e.balance_after))chain=false;
   seen.set(e.player_ref,{balance:BigInt(e.balance_after),revision:BigInt(e.player_sequence)});manifest.update(P.manifestLine(e));
  }
  const balances=crypto.createHash('sha256');let total=0n;
  for(const [ref,v]of [...seen.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)){total+=v.balance;balances.update(ref+'\t'+v.balance+'\t'+v.revision+'\n');}
  const checks={count:String(rows.length)===m.expected_count,contiguous,chain,ledger_manifest:manifest.digest('hex')===m.manifest_hash,
   balances_manifest:balances.digest('hex')===m.balances_hash,total_balance:String(total)===m.total_balance,player_count:String(seen.size)===m.player_count};
  const matches=Object.values(checks).every(Boolean),status=matches?(rows.length?'matched':'empty'):'mismatch';
  await db.query(`UPDATE gameops_source_wallet_streams SET key_id=$4,coverage_started_at=$5,through_sequence=$6,expected_count=$7,received_count=$8,status=$9,checks=$10,snapshot_hash=$11,source_checked_at=$12,source_commands_enabled=$13,checked_at=now() WHERE game_id=$1 AND environment=$2 AND stream_id=$3`,[gid,key.environment,key.streamId,key.id,m.coverage_started_at,m.through_sequence,m.expected_count,String(rows.length),status,JSON.stringify(checks),fingerprint,m.checked_at,m.commands_enabled]);
  return {status,checks,through_sequence:m.through_sequence,received_count:String(rows.length)};
 }
 async function poll(db,key,gid){
  if(!key.allowCommands)return {commands:[],commands_enabled:false};
  const q=await db.query(`SELECT c.*,p.player_ref FROM gameops_source_wallet_commands c JOIN gameops_source_players p ON p.id=c.source_player_id WHERE p.game_id=$1 AND p.environment=$2 AND p.stream_id=$3 AND c.status IN ('queued','delivered') AND (c.last_delivered_at IS NULL OR c.last_delivered_at<now()-interval '5 seconds') ORDER BY c.created_at LIMIT 10 FOR UPDATE OF c SKIP LOCKED`,[gid,key.environment,key.streamId]);
  const commands=[];
  for(const c of q.rows){
   await db.query("UPDATE gameops_source_wallet_commands SET status='delivered',last_delivered_at=now(),delivery_attempts=delivery_attempts+1 WHERE id=$1",[c.id]);
   if(c.status==='queued')await audit(db,'source:'+key.id,'source_wallet.command.dispatched',c.id,{request_id:c.request_id,environment:key.environment});
   commands.push({id:c.id,player_ref:c.player_ref,action:c.action,amount:String(c.amount),expected_revision:String(c.expected_revision),expires_at:new Date(c.expires_at).toISOString(),stream_id:key.streamId,game:key.game,environment:key.environment});
  }
  return {commands,commands_enabled:true};
 }
 async function commandResult(db,key,gid,m){
  const r=m.result,q=await db.query(`SELECT c.* FROM gameops_source_wallet_commands c JOIN gameops_source_players p ON p.id=c.source_player_id WHERE c.id=$1 AND p.game_id=$2 AND p.environment=$3 AND p.stream_id=$4 FOR UPDATE OF c`,[r.id,gid,key.environment,key.streamId]);
  if(!q.rowCount)P.bad('SOURCE_COMMAND_NOT_FOUND',404);
  const c=q.rows[0],fingerprint=P.hash(JSON.stringify(r));
  if(c.result_hash){if(c.result_hash!==fingerprint)P.bad('SOURCE_COMMAND_RESULT_CONFLICT',409);return {command_id:r.id,status:r.status,duplicate:true};}
  if(c.delivery_attempts<1)P.bad('COMMAND_NOT_DISPATCHED',409);
  if(r.status==='applied'){
   const e=(await db.query('SELECT * FROM gameops_source_wallet_entries WHERE command_id=$1 AND source_player_id=$2',[c.id,c.source_player_id])).rows[0];
   if(!e)P.bad('AWAITING_COMMAND_LEDGER',409);
   const delta=c.action==='credit'?BigInt(c.amount):-BigInt(c.amount);
   if(String(e.source_sequence)!==r.ledger_sequence||String(e.player_sequence)!==r.player_revision||String(e.balance_after)!==r.balance_after||BigInt(e.delta)!==delta||BigInt(e.player_sequence)!==BigInt(c.expected_revision)+1n)P.bad('COMMAND_LEDGER_RESULT_MISMATCH',409);
  }else{
   const found=await db.query('SELECT 1 FROM gameops_source_wallet_entries WHERE command_id=$1',[c.id]);if(found.rowCount)P.bad('REJECTED_COMMAND_HAS_LEDGER',409);
  }
  await db.query('UPDATE gameops_source_wallet_commands SET status=$2,result=$3,result_hash=$4,finished_at=now() WHERE id=$1',[c.id,r.status,JSON.stringify(r),fingerprint]);
  await audit(db,'source:'+key.id,'source_wallet.command.'+r.status,c.id,{request_id:c.request_id,reason:r.reason,ledger_sequence:r.ledger_sequence});
  return {command_id:r.id,status:r.status,duplicate:false};
 }
 async function process(raw,headers){
  const {key,nonce}=P.authenticate(raw,headers,keys);
  let v;try{v=JSON.parse(raw.toString('utf8'));}catch{P.bad('INVALID_WALLET_JSON');}
  const m=P.validate(v,key);
  const result=await transaction(pool,async db=>{
   const {gid,stream}=await lockStream(db,key);
   const n=await db.query("INSERT INTO gameops_source_wallet_nonces(key_id,nonce,expires_at) VALUES($1,$2,now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING nonce",[key.id,nonce]);
   if(!n.rowCount)P.bad('WALLET_NONCE_REPLAY',409);
   let out;
   if(m.type==='wallet.events')out=await acceptEvents(db,key,gid,m);
   else if(m.type==='wallet.reconcile')out=await reconcile(db,key,gid,m,stream);
   else if(m.type==='wallet.poll')out=await poll(db,key,gid);
   else out=await commandResult(db,key,gid,m);
   await db.query('DELETE FROM gameops_source_wallet_nonces WHERE expires_at<now()');
   return {accepted:true,type:m.type,game:key.game,environment:key.environment,stream_id:key.streamId,...out};
  });
  if(result.type!=='wallet.poll')logger.info('[source-wallet]',JSON.stringify({type:result.type,environment:key.environment,status:result.status,inserted:result.inserted,through_sequence:result.through_sequence}));
  return {result,key,nonce};
 }
 async function lookupPlayer(db,id,f,lock=false){
  if(!P.UUID.test(id||''))P.bad('INVALID_SOURCE_PLAYER');
  let q=await db.query(`SELECT ${playerCols} ${joined} WHERE ${scopeSql} AND p.id=$3`,[f.environment,f.game,id]);
  if(!q.rowCount)P.bad('SOURCE_PLAYER_NOT_FOUND_IN_SCOPE',404);
  if(lock){
   const p=q.rows[0];
   // Same lock ordering as ingestion: stream, then player, then request/command.
   await db.query('SELECT 1 FROM gameops_source_wallet_streams WHERE game_id=$1 AND environment=$2 AND stream_id=$3 FOR UPDATE',[p.game_id,p.environment,p.stream_id]);
   await db.query('SELECT 1 FROM gameops_source_players WHERE id=$1 FOR UPDATE',[id]);
   q=await db.query(`SELECT ${playerCols} ${joined} WHERE ${scopeSql} AND p.id=$3`,[f.environment,f.game,id]);
  }
  return q.rows[0];
 }
 const requestQuery=`SELECT r.id::text,r.source_player_id::text,r.action,r.amount::text,r.reason,r.requested_by,r.review_status,r.reviewed_by,r.review_note,r.version,r.created_at,r.reviewed_at,p.player_ref,p.stream_id::text,p.environment,g.slug,g.name AS game,c.id::text AS command_id,c.status AS command_status,c.expected_revision::text,c.delivery_attempts,c.last_delivered_at,c.expires_at,c.finished_at,c.result FROM gameops_source_wallet_requests r JOIN gameops_source_players p ON p.id=r.source_player_id JOIN gameops_games g ON g.id=p.game_id LEFT JOIN gameops_source_wallet_commands c ON c.request_id=r.id`;
 function mount(app){
  app.post(P.PATH,wrap(async(req,res)=>{
   if(req.originalUrl!==P.PATH)P.bad('CANONICAL_WALLET_PATH_REQUIRED');
   const {result,key,nonce}=await process(req.rawBody,req.headers),raw=Buffer.from(JSON.stringify(result));
   res.set('X-Wallet-Receipt',P.receiptSignature(key.secret,nonce,raw));res.type('json').send(raw);
  }));
  app.get('/api/admin/source-wallet/players',wrap(async(req,res)=>{
   const f=scope(req.query),observed=req.query.observed??null;
   if(observed!==null&&!P.UUID.test(observed))P.bad('INVALID_OBSERVED_PLAYER');
   const q=await pool.query(`SELECT ${playerCols} ${joined} WHERE ${scopeSql} AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM gameops_observed_players op WHERE op.id=$3 AND op.game_id=p.game_id AND op.environment=p.environment AND op.player_ref=p.player_ref)) ORDER BY p.received_at DESC,p.id LIMIT 100`,[f.environment,f.game,observed]);
   res.json({environment:f.environment,game:f.game,items:q.rows.map(decorate),limit:100,authority:'game_server',note:'Source-reported virtual balances. Opening snapshots start coverage; no prior history, PII or cash ownership is claimed.'});
  }));
  app.get('/api/admin/source-wallet/players/:id',wrap(async(req,res)=>{
   const f=scope(req.query),p=await lookupPlayer(pool,req.params.id,f);
   const before=req.query.before??null;if(before!==null&&!/^[1-9][0-9]{0,17}$/.test(before))P.bad('INVALID_WALLET_CURSOR');
   const events=await pool.query(`SELECT id::text,source_sequence::text,player_sequence::text,ledger_ref,kind,delta::text,balance_after::text,occurred_at,received_at,command_id::text FROM gameops_source_wallet_entries WHERE source_player_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 51`,[p.id,before]);
   const obs=await pool.query('SELECT id::text FROM gameops_observed_players WHERE game_id=$1 AND environment=$2 AND player_ref=$3',[p.game_id,p.environment,p.player_ref]);
   const has=events.rows.length>50,entries=events.rows.slice(0,50);
   res.json({item:decorate(p),entries,next_cursor:has?entries.at(-1).id:null,observed_player_id:obs.rows[0]?.id||null,
    note:'The game owns this balance. A request is not a credit until a signed applied receipt matches its source ledger entry. No banking, cashout, external identity, or odds changes.'});
  }));
  app.get('/api/admin/source-wallet/requests',wrap(async(req,res)=>{
   const f=scope(req.query),status=req.query.status??'all';if(!['all','pending','approved','rejected'].includes(status))P.bad('INVALID_REVIEW_FILTER');
   const q=await pool.query(requestQuery+` WHERE ${scopeSql} AND ($3='all' OR r.review_status=$3) ORDER BY r.created_at DESC LIMIT 100`,[f.environment,f.game,status]);
   res.json({items:q.rows.map(x=>({...x,state:requestState(x)})),environment:f.environment,game:f.game});
  }));
  app.get('/api/admin/source-wallet/requests/:id',wrap(async(req,res)=>{
   const f=scope(req.query);if(!P.UUID.test(req.params.id))P.bad('INVALID_SOURCE_REQUEST');
   const q=await pool.query(requestQuery+` WHERE ${scopeSql} AND r.id=$3`,[f.environment,f.game,req.params.id]);
   if(!q.rowCount)P.bad('SOURCE_REQUEST_NOT_FOUND',404);
   const r=q.rows[0];res.json({item:{...r,state:requestState(r)},note:'Approval queues a command. Only a verified source receipt and matching ledger prove application.'});
  }));
  app.post('/api/admin/source-wallet/requests',wrap(async(req,res)=>{
   const f=scope(req.query),v=req.body;
   if(!v||Object.keys(v).sort().join(',')!=='action,amount,idempotency_key,player_id,reason'||!P.UUID.test(v.player_id||'')||!P.UUID.test(v.idempotency_key||'')||!['credit','debit'].includes(v.action)||typeof v.reason!=='string'||v.reason.trim().length<5||v.reason.length>500||/[\x00-\x08\x0e-\x1f]/.test(v.reason))P.bad('INVALID_SOURCE_WALLET_REQUEST');
   P.integer(v.amount,{min:1n});const reason=v.reason.trim(),actor=req.auth.username;
   const fingerprint=P.hash(JSON.stringify([v.player_id,v.action,v.amount,reason,actor]));
   const result=await transaction(pool,async db=>{
    const p=await lookupPlayer(db,v.player_id,f);
    if(p.environment!=='staging')P.bad('WALLET_COMMANDS_STAGING_ONLY',403);
    const q=await db.query(`INSERT INTO gameops_source_wallet_requests(source_player_id,idempotency_key,payload_hash,action,amount,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id::text`,[p.id,v.idempotency_key,fingerprint,v.action,v.amount,reason,actor]);
    if(!q.rowCount){const prior=(await db.query('SELECT r.id::text,r.payload_hash,r.review_status,c.status AS command_status FROM gameops_source_wallet_requests r LEFT JOIN gameops_source_wallet_commands c ON c.request_id=r.id WHERE r.idempotency_key=$1',[v.idempotency_key])).rows[0];if(prior.payload_hash!==fingerprint)P.bad('WALLET_REQUEST_IDEMPOTENCY_CONFLICT',409);return {id:prior.id,replay:true,state:requestState(prior)};}
    await audit(db,actor,'source_wallet.request.created',q.rows[0].id,{player_id:p.id,action:v.action,amount:v.amount,environment:p.environment});
    return {id:q.rows[0].id,replay:false,state:'pending_approval'};
   });res.status(result.replay?200:201).json({ok:true,...result});
  }));
  app.post('/api/admin/source-wallet/requests/:id/review',wrap(async(req,res)=>{
   const f=scope(req.query),v=req.body;
   if(!P.UUID.test(req.params.id)||!v||Object.keys(v).sort().join(',')!=='decision,note,version'||!['approve','reject'].includes(v.decision)||!Number.isInteger(v.version)||v.version<1||typeof v.note!=='string'||v.note.trim().length<5||v.note.length>500)P.bad('INVALID_WALLET_REVIEW');
   const result=await transaction(pool,async db=>{
    const first=(await db.query('SELECT source_player_id FROM gameops_source_wallet_requests WHERE id=$1',[req.params.id])).rows[0];if(!first)P.bad('SOURCE_REQUEST_NOT_FOUND',404);
    const p=await lookupPlayer(db,first.source_player_id,f,true);
    const r=(await db.query('SELECT * FROM gameops_source_wallet_requests WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    if(r.review_status!=='pending'||r.version!==v.version)P.bad('WALLET_REVIEW_VERSION_CONFLICT',409);
    let command=null;
    if(v.decision==='approve'){
     if(!keyFor(p)?.allowCommands||!p.source_commands_enabled||p.environment!=='staging')P.bad('SOURCE_COMMANDS_DISABLED',403);
     if(verification(p)!=='matched')P.bad('SOURCE_BALANCE_NOT_FRESHLY_RECONCILED',409);
     const next=BigInt(p.balance)+(r.action==='credit'?BigInt(r.amount):-BigInt(r.amount));if(next<0n||next>1000000n)P.bad('SOURCE_BALANCE_LIMIT',409);
     command=(await db.query(`INSERT INTO gameops_source_wallet_commands(request_id,source_player_id,expected_revision,action,amount,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes') RETURNING id::text`,[r.id,p.id,p.revision,r.action,r.amount])).rows[0].id;
    }
    await db.query('UPDATE gameops_source_wallet_requests SET review_status=$2,reviewed_by=$3,review_note=$4,version=version+1,reviewed_at=now() WHERE id=$1',[r.id,v.decision==='approve'?'approved':'rejected',req.auth.username,v.note.trim()]);
    await audit(db,req.auth.username,'source_wallet.request.'+(v.decision==='approve'?'approved':'rejected'),r.id,{command_id:command,source_revision:p.revision});
    return {id:r.id,state:command?'queued':'rejected_by_admin',command_id:command};
   });res.json({ok:true,...result,applied:false});
  }));
 }
 return {init,mount,process,keys:keys.map(({secret,...safe})=>safe)};
}
module.exports={createSourceWallet,verification,scope,requestState};
