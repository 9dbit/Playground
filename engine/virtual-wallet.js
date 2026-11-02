'use strict';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENTRY=1000000000n,MAX_BALANCE=1000000000000n;
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const fail=(res,n,message)=>res.status(n).json({error:message});
const ddl=[
 'CREATE TABLE IF NOT EXISTS gameops_virtual_wallet_accounts (player_id uuid PRIMARY KEY REFERENCES gameops_players(id) ON DELETE RESTRICT,balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0 AND balance<=1000000000000),updated_at timestamptz NOT NULL DEFAULT now())',
 "CREATE TABLE IF NOT EXISTS gameops_virtual_wallet_operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),idempotency_key uuid NOT NULL UNIQUE,action text NOT NULL CHECK(action IN ('admin_credit','admin_debit','transfer')),actor text NOT NULL,source_player_id uuid REFERENCES gameops_players(id),target_player_id uuid REFERENCES gameops_players(id),amount bigint NOT NULL CHECK(amount>0 AND amount<=1000000000),note text NOT NULL,currency text NOT NULL DEFAULT 'DEMO_COIN' CHECK(currency='DEMO_COIN'),created_at timestamptz NOT NULL DEFAULT now())",
 'CREATE TABLE IF NOT EXISTS gameops_virtual_wallet_entries (id bigserial PRIMARY KEY,operation_id uuid NOT NULL REFERENCES gameops_virtual_wallet_operations(id) ON DELETE RESTRICT,player_id uuid NOT NULL REFERENCES gameops_players(id) ON DELETE RESTRICT,delta bigint NOT NULL,balance_after bigint NOT NULL CHECK(balance_after>=0 AND balance_after<=1000000000000),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(operation_id,player_id))',
 'CREATE INDEX IF NOT EXISTS gameops_wallet_entries_player_idx ON gameops_virtual_wallet_entries(player_id,id DESC)'
];
async function ensureSchema(pool){for(const q of ddl)await pool.query(q)}
const readInput=(p,transferring)=>{
 const amount=p?.amount,key=p?.idempotency_key,note=typeof p?.note==='string'?p.note.trim():'';
 if(!ID.test(key||'')||typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<=0||
 BigInt(amount)>MAX_ENTRY||note.length<5||note.length>500)return null;
 if(transferring&&!ID.test(p.to_player_id||''))return null;
 return {amount:BigInt(amount),key,note,to:p?.to_player_id};
};
async function transaction(pool,fn){
 const db=await pool.connect();
 try{await db.query('BEGIN');const result=await fn(db);await db.query(result?.error?'ROLLBACK':'COMMIT');return result}
 catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
}
async function lockedAccounts(db,ids){
 ids=[...new Set(ids)].sort();
 const players=await db.query('SELECT id,game_id FROM gameops_players WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
 if(players.rowCount!==ids.length)return {error:'Player not found',status:404};
 await db.query('INSERT INTO gameops_virtual_wallet_accounts(player_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING',[ids]);
 const q=await db.query('SELECT player_id,balance::text FROM gameops_virtual_wallet_accounts WHERE player_id=ANY($1::uuid[]) ORDER BY player_id FOR UPDATE',[ids]);
 return {balances:Object.fromEntries(q.rows.map(x=>[x.player_id,BigInt(x.balance)])),players:players.rows};
}
async function operation(db,p){
 const q=await db.query('INSERT INTO gameops_virtual_wallet_operations(idempotency_key,action,actor,source_player_id,target_player_id,amount,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id',
 [p.key,p.action,p.actor,p.from||null,p.to||null,p.amount.toString(),p.note]);
 if(q.rowCount)return {id:q.rows[0].id,replay:false};
 const existing=await db.query('SELECT id,action,actor,source_player_id,target_player_id,amount::text,note FROM gameops_virtual_wallet_operations WHERE idempotency_key=$1',[p.key]);
 const x=existing.rows[0];
 if(!x||x.action!==p.action||x.actor!==p.actor||x.source_player_id!==(p.from||null)||x.target_player_id!==(p.to||null)||BigInt(x.amount)!==p.amount||x.note!==p.note)return {conflict:true};
 return {id:x.id,replay:true};
}
async function entry(db,operationId,playerId,delta,balance){
 await db.query('INSERT INTO gameops_virtual_wallet_entries(operation_id,player_id,delta,balance_after) VALUES($1,$2,$3,$4)',
 [operationId,playerId,delta.toString(),balance.toString()]);
 await db.query('UPDATE gameops_virtual_wallet_accounts SET balance=$2,updated_at=now() WHERE player_id=$1',[playerId,balance.toString()]);
}
async function audit(db,actor,action,resource,p){
 await db.query('INSERT INTO gameops_audit(actor,action,resource,details) VALUES($1,$2,$3,$4)',[actor,action,resource,JSON.stringify(p)]);
}
function mount(app,{pool,currentActor}){
 app.get('/api/admin/virtual-wallets/:id',wrap(async(req,res)=>{
  if(!ID.test(req.params.id))return fail(res,400,'Invalid player ID');
  const [p,b,h]=await Promise.all([
   pool.query('SELECT id,player_ref,game_id FROM gameops_players WHERE id=$1',[req.params.id]),
   pool.query('SELECT balance::text FROM gameops_virtual_wallet_accounts WHERE player_id=$1',[req.params.id]),
   pool.query('SELECT e.id::text,e.delta::text,e.balance_after::text,o.action,o.note,o.actor,o.id AS operation_id,e.created_at FROM gameops_virtual_wallet_entries e JOIN gameops_virtual_wallet_operations o ON o.id=e.operation_id WHERE e.player_id=$1 ORDER BY e.id DESC LIMIT 100',[req.params.id])
  ]);
  if(!p.rowCount)return fail(res,404,'Player not found');
  res.json({player:p.rows[0],balance:b.rows[0]?.balance||'0',entries:h.rows,currency:'DEMO_COIN',
   externalWalletConnected:false,withdrawalsEnabled:false,
   notice:'Isolated virtual balance. No external game sync, cash value, or withdrawals.'});
 }));
 app.get('/api/admin/virtual-ledger',wrap(async(req,res)=>{
  const q=await pool.query('SELECT id,action,actor,source_player_id,target_player_id,amount::text,note,currency,created_at FROM gameops_virtual_wallet_operations ORDER BY created_at DESC LIMIT 200');
  res.json({items:q.rows,currency:'DEMO_COIN'});
 }));
 app.post('/api/admin/virtual-wallets/:id/adjust',wrap(async(req,res)=>{
  const id=req.params.id,mode=req.body?.action,p=readInput(req.body,false);
  if(!ID.test(id)||!['credit','debit'].includes(mode)||!p)return fail(res,400,'Invalid adjustment, amount, note or request ID');
  const actor=currentActor();
  const result=await transaction(pool,async db=>{
   const locked=await lockedAccounts(db,[id]);if(locked.error)return locked;
   const op=await operation(db,{...p,actor,action:'admin_'+mode,from:mode==='debit'?id:null,to:mode==='credit'?id:null});
   if(op.conflict)return {status:409,error:'Request ID is already used for a different operation'};
   if(op.replay)return {ok:true,replay:true,operationId:op.id};
   const next=locked.balances[id]+(mode==='credit'?p.amount:-p.amount);
   if(next<0n)return {status:409,error:'Insufficient virtual balance'};
   if(next>MAX_BALANCE)return {status:409,error:'Wallet limit exceeded'};
   await entry(db,op.id,id,mode==='credit'?p.amount:-p.amount,next);
   await audit(db,actor,'virtual_wallet.'+mode,id,{operationId:op.id,amount:p.amount.toString(),currency:'DEMO_COIN',note:p.note});
   return {ok:true,replay:false,operationId:op.id,balance:next.toString(),currency:'DEMO_COIN'};
  });
  if(result.error)return fail(res,result.status,result.error);
  res.json(result);
 }));
 app.post('/api/admin/virtual-wallets/:id/transfer',wrap(async(req,res)=>{
  const from=req.params.id,p=readInput(req.body,true);
  if(!ID.test(from)||!p||from===p.to)return fail(res,400,'Invalid virtual transfer');
  const actor=currentActor();
  const result=await transaction(pool,async db=>{
   const locked=await lockedAccounts(db,[from,p.to]);if(locked.error)return locked;
   if(locked.players[0].game_id!==locked.players[1].game_id)return {status:400,error:'Player wallets must belong to the same game'};
   const op=await operation(db,{...p,actor,action:'transfer',from});
   if(op.conflict)return {status:409,error:'Request ID conflict'};
   if(op.replay)return {ok:true,replay:true,operationId:op.id};
   const a=locked.balances[from]-p.amount,b=locked.balances[p.to]+p.amount;
   if(a<0n)return {status:409,error:'Insufficient virtual balance'};
   if(b>MAX_BALANCE)return {status:409,error:'Recipient wallet limit exceeded'};
   await entry(db,op.id,from,-p.amount,a);
   await entry(db,op.id,p.to,p.amount,b);
   await audit(db,actor,'virtual_wallet.transfer',from,{operationId:op.id,to:p.to,amount:p.amount.toString(),currency:'DEMO_COIN'});
   return {ok:true,replay:false,operationId:op.id,fromBalance:a.toString(),toBalance:b.toString(),currency:'DEMO_COIN'};
  });
  if(result.error)return fail(res,result.status,result.error);
  res.json(result);
 }));
}
module.exports={ensureSchema,mount,readInput};
