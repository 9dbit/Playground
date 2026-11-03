'use strict';
// CP16: staging-only source wallet proof and administratively queued commands.
// Game-source SQLite remains the ONLY balance writer. No production wallet sync.
const crypto=require('node:crypto');
const {RequestError,transaction}=require('./transaction');
const PATH='/api/v3/wallet-sync', ZERO='0'.repeat(64);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF=/^p_[0-9a-f]{64}$/;
const HASH=/^[0-9a-f]{64}$/;
const DEC=/^(0|[1-9][0-9]{0,15})$/;
const SMALL=/^(0|[1-9][0-9]{0,6})$/;
const TYPES=['welcome','daily','refill','orbit_stake','orbit_payout','spin_stake','spin_payout','admin_credit','admin_debit'];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const hmac=(secret,message)=>crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(message).digest('hex');
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&HASH.test(a)&&HASH.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const fail=(status,code)=>{throw new RequestError(status,code,code)};
function configuration(raw){
 if(!raw)return [];
 let list;try{list=JSON.parse(raw)}catch{throw Error('Invalid GAMEOPS_WALLET_KEYS JSON')}
 if(!Array.isArray(list)||list.length>10)throw Error('Wallet key configuration must be an array <=10');
 const used=new Set();
 return list.map(k=>{
  if(!k||typeof k!=='object'||!Object.keys(k).every(x=>['id','secret','game','environment','enabled'].includes(x))||
   !/^[a-z0-9-]{3,60}$/.test(k.id||'')||used.has(k.id)||!HASH.test(k.secret||'')||
   k.game!=='uno-luck'||k.environment!=='staging'||(k.enabled!==undefined&&typeof k.enabled!=='boolean'))throw Error('Wallet key must be staging UNO only and unique');
  used.add(k.id);return Object.freeze({...k,enabled:k.enabled!==false});
 });
}
function signature(secret,ts,nonce,raw){
 return hmac(secret,['gameops.wallet.v1','POST',PATH,ts,nonce,sha(raw)].join('\n'));
}
function receiptSignature(secret,nonce,raw){
 return hmac(secret,['gameops.wallet.receipt.v1',nonce,sha(raw)].join('\n'));
}
function commandHash(c){
 return sha('gameops.wallet.command.v1\n'+['id','game','environment','stream_id','player_ref','action','amount','expected_version','expires_at'].map(k=>String(c[k])).join('\n'));
}
function entryHash(prev,e){
 return sha(prev+'\n'+['version','entry_id','reason','delta','balance_before','balance_after','occurred_at'].map(k=>String(e[k])).join('\t')+'\n');
}
function positive(value,max){
 if(typeof value!=='string'||!DEC.test(value)||BigInt(value)>BigInt(max))fail(400,'INVALID_WALLET_AMOUNT');
 return Number(value);
}
function iso(value){
 if(typeof value!=='string'||value.length>36||!/^\d{4}-\d{2}-\d{2}T.+Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail(400,'INVALID_WALLET_TIME');
 return value;
}
function validatePacket(p,key,now=Date.now()){
 if(!p||typeof p!=='object'||Array.isArray(p)||p.schema_version!==1||p.type!=='wallet.sync'||p.game!==key.game||p.environment!==key.environment||
   !UUID.test(p.stream_id||'')||!REF.test(p.player_ref||''))fail(403,'WALLET_SCOPE_MISMATCH');
 if(!Array.isArray(p.entries)||p.entries.length>50||!Array.isArray(p.receipts)||p.receipts.length>10||!Array.isArray(p.requests)||p.requests.length>10||
  !p.snapshot||typeof p.snapshot!=='object'||Array.isArray(p.snapshot))fail(400,'INVALID_WALLET_PAYLOAD');
 const s=p.snapshot;
 if(typeof s.version!=='string'||!DEC.test(s.version)||BigInt(s.version)>1000000000n||!SMALL.test(s.balance||'')||
    positive(s.balance,1000000)<0||!HASH.test(s.manifest||'')||typeof s.commands_enabled!=='boolean'||typeof s.active_round!=='boolean'||
    Math.abs(now-Date.parse(iso(s.captured_at)))>300000)fail(400,'INVALID_WALLET_SNAPSHOT');
 const used=new Set();
 for(const e of p.entries){
  if(!e||typeof e!=='object'||!DEC.test(e.version||'')||e.version==='0'||!/^.{1,120}$/.test(e.entry_id||'')||
   typeof e.reason!=='string'||e.reason.length>100||!/^[a-z0-9_.-]+$/.test(e.reason)||
   typeof e.delta!=='string'||!/^-?(0|[1-9]\d{0,6})$/.test(e.delta)||
   !SMALL.test(e.balance_before||'')||!SMALL.test(e.balance_after||'')||
   positive(e.balance_before,1000000)<0||positive(e.balance_after,1000000)<0||
   !HASH.test(e.chain_hash||'')||used.has(e.version)||Math.abs(now-Date.parse(iso(e.occurred_at)))>90*86400000)fail(400,'INVALID_WALLET_JOURNAL');
  used.add(e.version);
 }
 for(const r of p.requests)if(!r||!UUID.test(r.id||'')||typeof r.amount!=='string'||!DEC.test(r.amount)||
    positive(r.amount,10000)<1||typeof r.note!=='string'||r.note.trim().length<5||r.note.length>300||
    /[\u0000-\u001f]/.test(r.note))fail(400,'INVALID_CREDIT_REQUEST');
 for(const r of p.receipts)if(!r||!UUID.test(r.command_id||'')||!HASH.test(r.request_hash||'')||
    !['applied','failed'].includes(r.status)||!/^[a-z0-9_]{2,60}$/.test(r.code||'')||
    typeof r.version!=='string'||!DEC.test(r.version)||!SMALL.test(r.balance||'')||
    positive(r.balance,1000000)<0||(r.entry_id!==null&&!(typeof r.entry_id==='string'&&r.entry_id.length<=120)))fail(400,'INVALID_COMMAND_RECEIPT');
 return p;
}
function authenticate(headers,raw,keys,now=Date.now()){
 if(!Buffer.isBuffer(raw)||raw.length<2||raw.length>65536)fail(413,'WALLET_BODY_LIMIT');
 const id=headers['x-wallet-key'],ts=headers['x-wallet-time'],nonce=headers['x-wallet-nonce'],sig=headers['x-wallet-signature'];
 const key=keys.find(x=>x.enabled&&x.id===id);
 if(!key||!/^\d{10,11}$/.test(ts||'')||!/^[a-f0-9]{32}$/.test(nonce||'')||
   !safeEqual(sig,signature(key.secret,ts,nonce,raw))||Math.abs(now-Number(ts)*1000)>300000)fail(401,'INVALID_WALLET_SIGNATURE');
 return {key,nonce};
}
const DDL=[
 "CREATE TABLE IF NOT EXISTS gameops_wallet_nonces(key_id text NOT NULL,nonce text NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(key_id,nonce))",
 "CREATE INDEX IF NOT EXISTS gameops_wallet_nonce_expiry_idx ON gameops_wallet_nonces(expires_at)",
 "CREATE TABLE IF NOT EXISTS gameops_source_wallets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),game_id uuid NOT NULL REFERENCES gameops_games(id),observed_player_id uuid NOT NULL REFERENCES gameops_observed_players(id),environment text NOT NULL CHECK(environment='staging'),stream_id uuid NOT NULL,player_ref text NOT NULL,version bigint NOT NULL DEFAULT 0 CHECK(version>=0),balance bigint NOT NULL DEFAULT 0 CHECK(balance BETWEEN 0 AND 1000000),manifest text NOT NULL,commands_enabled boolean NOT NULL DEFAULT false,active_round boolean NOT NULL DEFAULT false,reconciliation text NOT NULL DEFAULT 'pending',source_checked_at timestamptz,last_seen timestamptz NOT NULL DEFAULT now(),UNIQUE(game_id,environment,player_ref))",
 "CREATE INDEX IF NOT EXISTS gameops_source_wallet_scope_idx ON gameops_source_wallets(environment,game_id,last_seen DESC)",
 "CREATE TABLE IF NOT EXISTS gameops_source_wallet_entries(wallet_id uuid NOT NULL REFERENCES gameops_source_wallets(id),version bigint NOT NULL CHECK(version>0),entry_id text NOT NULL,reason text NOT NULL,delta bigint NOT NULL,balance_before bigint NOT NULL,balance_after bigint NOT NULL,occurred_at timestamptz NOT NULL,chain_hash text NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_id,version),UNIQUE(wallet_id,entry_id))",
 "CREATE TABLE IF NOT EXISTS gameops_source_wallet_commands(id uuid PRIMARY KEY,wallet_id uuid NOT NULL REFERENCES gameops_source_wallets(id),game_id uuid NOT NULL REFERENCES gameops_games(id),environment text NOT NULL CHECK(environment='staging'),action text NOT NULL CHECK(action IN ('credit','debit')),amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 10000),reason text NOT NULL,expected_version bigint NOT NULL,expires_at timestamptz NOT NULL,request_hash text NOT NULL,request_id uuid,actor text NOT NULL,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','delivered','applied','failed')),source_code text,source_version bigint,source_balance bigint,source_entry_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())",
 "CREATE INDEX IF NOT EXISTS gameops_wallet_commands_wallet_idx ON gameops_source_wallet_commands(wallet_id,created_at DESC)",
 "CREATE UNIQUE INDEX IF NOT EXISTS gameops_wallet_active_command_idx ON gameops_source_wallet_commands(wallet_id) WHERE state IN ('queued','delivered')",
 "CREATE TABLE IF NOT EXISTS gameops_source_wallet_requests(id uuid PRIMARY KEY,wallet_id uuid NOT NULL REFERENCES gameops_source_wallets(id),amount bigint NOT NULL CHECK(amount BETWEEN 1 AND 10000),note text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','queued','applied','failed','rejected')),command_id uuid UNIQUE REFERENCES gameops_source_wallet_commands(id),reviewed_by text,review_note text,created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz)"
].join(';\n')+';';
function scope(q){
 if(!q||q.environment!=='staging'||q.game!=='uno-luck')fail(400,'Explicit staging UNO scope required');
 return {game:'uno-luck',environment:'staging'};
}
function checkAmount(x){if(typeof x!=='string'||!/^[1-9][0-9]{0,4}$/.test(x)||Number(x)>10000)fail(400,'INVALID_COMMAND_AMOUNT');return Number(x)}
function actor(req){if(!req.auth||req.auth.role!=='owner'||!req.auth.mfa_verified||req.auth.must_change_password)fail(403,'FULL_OWNER_AUTH_REQUIRED');return req.auth.username}
function createWallet({pool,keysRaw=process.env.GAMEOPS_WALLET_KEYS,commandsAllowed=()=>process.env.GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED==='1'}){
 const keys=configuration(keysRaw);
 async function init(){await pool.query(DDL);await pool.query("DELETE FROM gameops_wallet_nonces WHERE expires_at<now()");}
 async function handle(raw,headers){
  const {key,nonce}=authenticate(headers,raw,keys);
  let p;try{p=JSON.parse(raw.toString('utf8'))}catch{fail(400,'INVALID_WALLET_JSON')}
  validatePacket(p,key);
  const answer=await transaction(pool,async db=>{
   const n=await db.query("INSERT INTO gameops_wallet_nonces(key_id,nonce,expires_at) VALUES($1,$2,now()+interval '11 minutes') ON CONFLICT DO NOTHING RETURNING nonce",[key.id,nonce]);
   if(!n.rowCount)fail(409,'WALLET_NONCE_REPLAY');
   const g=await db.query('SELECT id FROM gameops_games WHERE slug=$1',['uno-luck']);
   if(!g.rowCount)fail(409,'WALLET_GAME_UNKNOWN');
   const gameId=g.rows[0].id;
   const observed=await db.query("INSERT INTO gameops_observed_players(game_id,environment,player_ref) VALUES($1,'staging',$2) ON CONFLICT(game_id,environment,player_ref) DO UPDATE SET last_seen=greatest(gameops_observed_players.last_seen,now()) RETURNING id",[gameId,p.player_ref]);
   const seed=await db.query("INSERT INTO gameops_source_wallets(game_id,observed_player_id,environment,stream_id,player_ref,manifest) VALUES($1,$2,'staging',$3,$4,$5) ON CONFLICT(game_id,environment,player_ref) DO NOTHING RETURNING id",[gameId,observed.rows[0].id,p.stream_id,p.player_ref,ZERO]);
   const current=await db.query("SELECT * FROM gameops_source_wallets WHERE game_id=$1 AND environment='staging' AND player_ref=$2 FOR UPDATE",[gameId,p.player_ref]);
   if(!current.rowCount)fail(409,'WALLET_NOT_REGISTERED');
   const w=current.rows[0];
   if(w.stream_id!==p.stream_id)fail(409,'WALLET_STREAM_CONFLICT');
   let version=BigInt(w.version),balance=BigInt(w.balance),manifest=w.manifest;
   const ackRequests=[],ackReceipts=[];
   for(const e of p.entries){
    const ver=BigInt(e.version),before=BigInt(e.balance_before),after=BigInt(e.balance_after),delta=BigInt(e.delta);
    if(before+delta!==after||after<0n||after>1000000n)fail(409,'WALLET_ENTRY_BALANCE_CONFLICT');
    if(ver<=version){
     const old=await db.query('SELECT entry_id,chain_hash,reason,delta::text,balance_before::text,balance_after::text,occurred_at FROM gameops_source_wallet_entries WHERE wallet_id=$1 AND version=$2',[w.id,e.version]);
     if(!old.rowCount||old.rows[0].entry_id!==e.entry_id||old.rows[0].chain_hash!==e.chain_hash||old.rows[0].reason!==e.reason||old.rows[0].delta!==e.delta||old.rows[0].balance_before!==e.balance_before||old.rows[0].balance_after!==e.balance_after||new Date(old.rows[0].occurred_at).toISOString()!==new Date(e.occurred_at).toISOString())fail(409,'WALLET_ENTRY_CONFLICT');
     continue;
    }
    if(ver!==version+1n||before!==balance||entryHash(manifest,e)!==e.chain_hash)fail(409,'WALLET_ENTRY_CHAIN_MISMATCH');
    await db.query('INSERT INTO gameops_source_wallet_entries(wallet_id,version,entry_id,reason,delta,balance_before,balance_after,occurred_at,chain_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[w.id,e.version,e.entry_id,e.reason,e.delta,e.balance_before,e.balance_after,e.occurred_at,e.chain_hash]);
    version=ver;balance=after;manifest=e.chain_hash;
   }
   const snapVer=BigInt(p.snapshot.version);
   if(p.entries.some(e=>BigInt(e.version)>snapVer))fail(409,'WALLET_ENTRY_AHEAD_OF_SNAPSHOT');
   if(snapVer===version&&(p.snapshot.manifest!==manifest||BigInt(p.snapshot.balance)!==balance))fail(409,'WALLET_SOURCE_SNAPSHOT_CONFLICT');
   const reconciliation=snapVer===version?'matched':snapVer>version?'pending':'stale';
   await db.query('UPDATE gameops_source_wallets SET version=$2,balance=$3,manifest=$4,commands_enabled=$5,active_round=$6,reconciliation=$7,source_checked_at=$8,last_seen=now() WHERE id=$1',[w.id,String(version),String(balance),manifest,p.snapshot.commands_enabled,p.snapshot.active_round,reconciliation,p.snapshot.captured_at]);
   for(const r of p.requests){
    const prev=await db.query('SELECT wallet_id,amount::text,note FROM gameops_source_wallet_requests WHERE id=$1',[r.id]);
    if(prev.rowCount){if(prev.rows[0].wallet_id!==w.id||prev.rows[0].amount!==r.amount||prev.rows[0].note!==r.note)fail(409,'WALLET_REQUEST_CONFLICT');}
    else await db.query('INSERT INTO gameops_source_wallet_requests(id,wallet_id,amount,note) VALUES($1,$2,$3,$4)',[r.id,w.id,r.amount,r.note]);
    ackRequests.push(r.id);
   }
   for(const receipt of p.receipts){
    const q=await db.query('SELECT * FROM gameops_source_wallet_commands WHERE id=$1 AND wallet_id=$2 FOR UPDATE',[receipt.command_id,w.id]);
    if(!q.rowCount||q.rows[0].request_hash!==receipt.request_hash)fail(409,'WALLET_RECEIPT_CONFLICT');
    const c=q.rows[0];
    if(receipt.status==='applied'){
     if(receipt.code!=='ok'||c.state==='failed')fail(409,'WALLET_RECEIPT_STATE_CONFLICT');
     const expectedEntry='admin.'+c.id;
     const row=await db.query('SELECT * FROM gameops_source_wallet_entries WHERE wallet_id=$1 AND version=$2',[w.id,receipt.version]);
     if(!row.rowCount||row.rows[0].entry_id!==expectedEntry||receipt.entry_id!==expectedEntry||
       BigInt(row.rows[0].balance_after)!==BigInt(receipt.balance)||
       BigInt(row.rows[0].delta)!==BigInt(c.amount)*(c.action==='credit'?1n:-1n)||
       row.rows[0].reason!=='admin_'+c.action)continue; // No success until source ledger proof.
     await db.query("UPDATE gameops_source_wallet_commands SET state='applied',source_code=$2,source_version=$3,source_balance=$4,source_entry_id=$5,updated_at=now() WHERE id=$1",[c.id,receipt.code,receipt.version,receipt.balance,receipt.entry_id]);
     await db.query("UPDATE gameops_source_wallet_requests SET state='applied' WHERE command_id=$1",[c.id]);
    }else{
     if(c.state==='applied')fail(409,'WALLET_RECEIPT_STATE_CONFLICT');
     await db.query("UPDATE gameops_source_wallet_commands SET state='failed',source_code=$2,source_version=$3,source_balance=$4,updated_at=now() WHERE id=$1",[c.id,receipt.code,receipt.version,receipt.balance]);
     await db.query("UPDATE gameops_source_wallet_requests SET state='failed' WHERE command_id=$1",[c.id]);
    }
    ackReceipts.push(c.id);
   }
   const commands=[];
   if(commandsAllowed()&&p.snapshot.commands_enabled&&reconciliation==='matched'&&!p.snapshot.active_round){
    const pending=await db.query("SELECT * FROM gameops_source_wallet_commands WHERE wallet_id=$1 AND state IN ('queued','delivered') ORDER BY created_at LIMIT 1",[w.id]);
    if(pending.rowCount){
     const c=pending.rows[0],deadline=new Date(c.expires_at).toISOString();
     const packet={id:c.id,game:'uno-luck',environment:'staging',stream_id:p.stream_id,player_ref:p.player_ref,action:c.action,amount:String(c.amount),expected_version:String(c.expected_version),expires_at:deadline,request_hash:c.request_hash};
     if(commandHash(packet)!==c.request_hash)fail(500,'INVALID_STORED_COMMAND_HASH');
     await db.query("UPDATE gameops_source_wallet_commands SET state='delivered',updated_at=now() WHERE id=$1",[c.id]);
     commands.push(packet);
    }
   }
   await db.query("DELETE FROM gameops_wallet_nonces WHERE expires_at<now()");
   return {type:'wallet.sync',game:'uno-luck',environment:'staging',stream_id:p.stream_id,player_ref:p.player_ref,accepted:true,ack_version:String(version),reconciliation,request_acks:ackRequests,receipt_acks:ackReceipts,commands};
  });
  const bytes=Buffer.from(JSON.stringify(answer));
  return {bytes,receipt:receiptSignature(key.secret,nonce,bytes)};
 }
 async function queue(db,w,{id,action,amount,expected_version,reason,request_id},username){
  if(!commandsAllowed())fail(409,'WALLET_ADMIN_COMMANDS_DISABLED');
  if(w.environment!=='staging'||w.reconciliation!=='matched'||!w.commands_enabled||w.active_round||!w.last_seen||Date.now()-Date.parse(w.last_seen)>90000)fail(409,'WALLET_SOURCE_NOT_READY');
  if(String(w.version)!==expected_version)fail(409,'WALLET_SOURCE_VERSION_CHANGED');
  const existing=await db.query("SELECT id FROM gameops_source_wallet_commands WHERE wallet_id=$1 AND state IN ('queued','delivered') LIMIT 1",[w.id]);
  if(existing.rowCount)fail(409,'WALLET_COMMAND_ALREADY_PENDING');
  const expiry=new Date(Date.now()+8*60000).toISOString();
  const packet={id,game:'uno-luck',environment:'staging',stream_id:w.stream_id,player_ref:w.player_ref,action,amount:String(amount),expected_version,expires_at:expiry};
  const hash=commandHash(packet);
  const q=await db.query("INSERT INTO gameops_source_wallet_commands(id,wallet_id,game_id,environment,action,amount,reason,expected_version,expires_at,request_hash,request_id,actor) VALUES($1,$2,$3,'staging',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,state,amount::text,action,expected_version::text,created_at",[id,w.id,w.game_id,action,amount,reason,expected_version,expiry,hash,request_id||null,username]);
  await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',[username,'source_wallet.command.queued',id,JSON.stringify({wallet_id:w.id,action,amount,reason,environment:'staging',game:'uno-luck',request_id:request_id||null})]);
  return q.rows[0];
 }
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 function mount(app){
  app.post(PATH,wrap(async(req,res)=>{
   if(req.originalUrl!==PATH)fail(400,'CANONICAL_WALLET_PATH_REQUIRED');
   const result=await handle(req.rawBody,req.headers);
   res.set('X-Wallet-Receipt',result.receipt).type('json').status(200).send(result.bytes);
  }));
  app.get('/api/admin/source-wallet/summary',wrap(async(req,res)=>{
   scope(req.query);
   const q=await pool.query("SELECT count(*)::text AS players,coalesce(sum(balance),0)::text AS source_balance,count(*) FILTER (WHERE reconciliation='matched')::text AS matched,count(*) FILTER (WHERE last_seen<now()-interval '90 seconds')::text AS stale FROM gameops_source_wallets WHERE environment='staging'");
   const r=await pool.query("SELECT count(*) FILTER (WHERE state IN ('queued','delivered'))::text AS pending_commands,count(*) FILTER (WHERE state='applied')::text AS applied_commands FROM gameops_source_wallet_commands");
   const p=await pool.query("SELECT count(*) FILTER (WHERE state='pending')::text AS pending_requests FROM gameops_source_wallet_requests");
   res.json({scope:'uno-luck/staging',currency:'DEMO_COIN',hasCashValue:false,sourceOfTruth:'UNO SQLite',commandsConfigured:commandsAllowed(),...q.rows[0],...r.rows[0],...p.rows[0],last_checked:new Date().toISOString()});
  }));
  app.get('/api/admin/source-wallet/players',wrap(async(req,res)=>{
   scope(req.query);
   const q=await pool.query("SELECT w.id::text,w.observed_player_id::text,w.player_ref,w.version::text,w.balance::text,w.reconciliation,w.commands_enabled,w.active_round,w.last_seen,w.source_checked_at FROM gameops_source_wallets w WHERE w.environment='staging' ORDER BY w.last_seen DESC,w.id LIMIT 100");
   res.json({items:q.rows,currency:'DEMO_COIN',note:'Source balances are virtual and non-redeemable, not inferred from round totals.'});
  }));
  app.get('/api/admin/source-wallet/players/:id',wrap(async(req,res)=>{
   scope(req.query);if(!UUID.test(req.params.id))fail(400,'INVALID_WALLET_ID');
   const q=await pool.query("SELECT id::text,observed_player_id::text,player_ref,stream_id::text,version::text,balance::text,reconciliation,commands_enabled,active_round,last_seen,source_checked_at FROM gameops_source_wallets WHERE (id=$1 OR observed_player_id=$1) AND environment='staging'",[req.params.id]);
   if(!q.rowCount)fail(404,'WALLET_NOT_FOUND');
   const entries=await pool.query("SELECT version::text,entry_id,reason,delta::text,balance_before::text,balance_after::text,occurred_at,received_at FROM gameops_source_wallet_entries WHERE wallet_id=$1 ORDER BY version DESC LIMIT 100",[req.params.id]);
   const cmds=await pool.query("SELECT id::text,state,action,amount::text,reason,expected_version::text,source_code,source_version::text,source_balance::text,created_at,updated_at FROM gameops_source_wallet_commands WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 50",[req.params.id]);
   res.json({item:q.rows[0],entries:entries.rows,commands:cmds.rows,commandsAllowed:commandsAllowed(),note:'The game server determines balance. Admin approval alone never changes it.'});
  }));
  app.get('/api/admin/source-wallet/requests',wrap(async(req,res)=>{
   scope(req.query);
   const q=await pool.query("SELECT r.id::text,r.wallet_id::text,r.amount::text,r.note,r.state,r.command_id::text,r.reviewed_by,r.review_note,r.created_at,r.reviewed_at,w.player_ref FROM gameops_source_wallet_requests r JOIN gameops_source_wallets w ON w.id=r.wallet_id WHERE w.environment='staging' ORDER BY r.created_at DESC LIMIT 200");
   res.json({items:q.rows});
  }));
  app.post('/api/admin/source-wallet/players/:id/commands',wrap(async(req,res)=>{
   scope(req.query);const username=actor(req);if(!UUID.test(req.params.id))fail(400,'INVALID_WALLET_ID');
   const b=req.body||{};if(!UUID.test(b.id||'')||!['credit','debit'].includes(b.action)||!DEC.test(b.expected_version||'')||
     typeof b.reason!=='string'||b.reason.trim().length<8||b.reason.length>300)fail(400,'INVALID_COMMAND');
   const amount=checkAmount(b.amount),reason=b.reason.trim();
   const result=await transaction(pool,async db=>{
    const old=await db.query('SELECT id,wallet_id,state,action,amount::text,reason,expected_version::text FROM gameops_source_wallet_commands WHERE id=$1',[b.id]);
    if(old.rowCount){
     const x=old.rows[0];if(x.wallet_id!==req.params.id||x.action!==b.action||x.amount!==b.amount||x.reason!==reason||x.expected_version!==b.expected_version)fail(409,'COMMAND_ID_CONFLICT');
     return {item:x,replay:true};
    }
    const q=await db.query("SELECT * FROM gameops_source_wallets WHERE id=$1 AND environment='staging' FOR UPDATE",[req.params.id]);
    if(!q.rowCount)fail(404,'WALLET_NOT_FOUND');
    return {item:await queue(db,q.rows[0],{id:b.id,action:b.action,amount,expected_version:b.expected_version,reason},username),replay:false};
   });
   res.status(result.replay?200:202).json({...result,balanceChanged:false,state:'awaiting_source_confirmation'});
  }));
  app.post('/api/admin/source-wallet/requests/:id/review',wrap(async(req,res)=>{
   scope(req.query);const username=actor(req);if(!UUID.test(req.params.id))fail(400,'INVALID_REQUEST_ID');
   const b=req.body||{};if(!['approve','reject'].includes(b.decision)||typeof b.reason!=='string'||b.reason.trim().length<8||b.reason.length>300)fail(400,'INVALID_REVIEW');
   if(b.decision==='approve'&&!UUID.test(b.command_id||''))fail(400,'INVALID_COMMAND_ID');
   const result=await transaction(pool,async db=>{
    const initial=await db.query('SELECT wallet_id FROM gameops_source_wallet_requests WHERE id=$1',[req.params.id]);
    if(!initial.rowCount)fail(404,'REQUEST_NOT_FOUND');
    const lock=await db.query('SELECT * FROM gameops_source_wallets WHERE id=$1 FOR UPDATE',[initial.rows[0].wallet_id]);
    const qr=await db.query('SELECT * FROM gameops_source_wallet_requests WHERE id=$1 FOR UPDATE',[req.params.id]);
    if(qr.rows[0].state!=='pending')fail(409,'REQUEST_ALREADY_REVIEWED');
    let command=null;
    if(b.decision==='approve'){
     command=await queue(db,lock.rows[0],{id:b.command_id,action:'credit',amount:Number(qr.rows[0].amount),expected_version:String(lock.rows[0].version),reason:b.reason.trim(),request_id:req.params.id},username);
    }
    const state=b.decision==='approve'?'queued':'rejected';
    await db.query('UPDATE gameops_source_wallet_requests SET state=$2,command_id=$3,reviewed_by=$4,review_note=$5,reviewed_at=now() WHERE id=$1',[req.params.id,state,command?.id||null,username,b.reason.trim()]);
    await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',[username,'source_wallet.request.reviewed',req.params.id,JSON.stringify({decision:b.decision,command_id:command?.id||null,reason:b.reason.trim()})]);
    return {id:req.params.id,state,command_id:command?.id||null};
   });
   res.status(result.state==='queued'?202:200).json({item:result,balanceChanged:false});
  }));
 }
 return {init,mount,handle,keys};
}
module.exports={createWallet,configuration,signature,receiptSignature,entryHash,commandHash,validatePacket,authenticate,scope,PATH,ZERO};
