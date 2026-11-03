'use strict';
const crypto = require('node:crypto');
const { RequestError } = require('./transaction');
const PATH = '/api/v3/source-wallet';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYER = /^p_[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{64}$/;
const KINDS = ['opening_snapshot','welcome','daily','free_refill','spin_win','spin_loss','orbit_stake','orbit_payout','admin_credit','admin_debit'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const bad = (code, status = 400) => { throw new RequestError(status, code, code); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
function configuration(raw) {
  if (!raw) return [];
  let all; try { all = JSON.parse(raw); } catch { throw Error('Invalid wallet key JSON'); }
  if (!Array.isArray(all) || all.length > 10) throw Error('Wallet key configuration must be an array');
  const ids = new Set(), streams = new Set();
  return all.map(k => {
    if (!k || !/^[a-z0-9-]{3,60}$/.test(k.id || '') || ids.has(k.id) || !HEX.test(k.secret || '') ||
        k.game !== 'uno-luck' || !['staging','production'].includes(k.environment) || !UUID.test(k.streamId || '') ||
        typeof k.allowCommands !== 'boolean' || (k.enabled !== undefined && typeof k.enabled !== 'boolean') ||
        (k.allowCommands && k.environment !== 'staging')) throw Error('Invalid wallet key scope; commands supported only on UNO staging');
    const scope = k.game+':'+k.environment+':'+k.streamId;
    if (streams.has(scope)) throw Error('Duplicate wallet key stream');
    ids.add(k.id); streams.add(scope);
    return Object.freeze({...k, enabled:k.enabled!==false});
  });
}
function signature(secret, ts, nonce, raw) {
  return crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(['gameops.wallet.v1','POST',PATH,ts,nonce,hash(raw)].join('\n')).digest('hex');
}
function receiptSignature(secret, nonce, raw) {
  return crypto.createHmac('sha256',Buffer.from(secret,'hex')).update(['gameops.wallet.receipt.v1',nonce,hash(raw)].join('\n')).digest('hex');
}
function authenticate(raw, headers, keys, now=Date.now()) {
  if (!Buffer.isBuffer(raw) || raw.length < 2 || raw.length > 65536) bad('WALLET_BODY_LIMIT',413);
  const id=headers['x-wallet-key'],ts=headers['x-wallet-timestamp'],nonce=headers['x-wallet-nonce'],mac=headers['x-wallet-signature'];
  const k=keys.find(x=>x.id===id&&x.enabled);
  if (!k || !/^\d{10,11}$/.test(ts||'') || !/^[0-9a-f]{32}$/.test(nonce||'') || !HEX.test(mac||'') || Math.abs(Number(ts)-now/1000)>300) bad('INVALID_WALLET_SIGNATURE',401);
  if (!crypto.timingSafeEqual(Buffer.from(signature(k.secret,ts,nonce,raw),'hex'),Buffer.from(mac,'hex'))) bad('INVALID_WALLET_SIGNATURE',401);
  return {key:k,nonce};
}
function integer(value,{signed=false,max=1000000n,min=0n}={}) {
  if (typeof value!=='string'||!(signed?/^(0|-?[1-9]\d{0,14})$/:/^(0|[1-9]\d{0,14})$/).test(value)) bad('INVALID_WALLET_INTEGER');
  const n=BigInt(value);if(n<min||n>max)bad('WALLET_INTEGER_RANGE');return value;
}
function date(value,{fresh=false}={}) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)||!Number.isFinite(Date.parse(value))||Date.parse(value)>Date.now()+60000||Date.parse(value)<Date.parse('2020-01-01'))bad('INVALID_WALLET_TIMESTAMP');
  if(fresh && Date.parse(value)<Date.now()-300000)bad('STALE_WALLET_SNAPSHOT');
  return new Date(value).toISOString();
}
const EVENT_KEYS=['sequence','player_sequence','player_ref','ledger_ref','kind','delta','balance_after','occurred_at','command_id'];
function event(v) {
  if(!exact(v,EVENT_KEYS)||!PLAYER.test(v.player_ref||'')||!/^l_[0-9a-f]{64}$/.test(v.ledger_ref||'')||!KINDS.includes(v.kind))bad('INVALID_WALLET_EVENT');
  integer(v.sequence,{min:1n,max:100000n});integer(v.player_sequence,{min:1n,max:100000n});
  integer(v.delta,{signed:true,min:-1000000n});integer(v.balance_after);
  const admin=v.kind==='admin_credit'||v.kind==='admin_debit';
  if(admin?!UUID.test(v.command_id||''):v.command_id!==null)bad('INVALID_WALLET_COMMAND_REFERENCE');
  if(v.kind==='admin_credit'&&BigInt(v.delta)<=0n||v.kind==='admin_debit'&&BigInt(v.delta)>=0n)bad('INVALID_WALLET_COMMAND_DELTA');
  if(v.kind==='opening_snapshot'&&v.player_sequence!=='1')bad('INVALID_OPENING_SNAPSHOT');
  return {...v,occurred_at:date(v.occurred_at)};
}
function manifestLine(e) { return EVENT_KEYS.map(k=>e[k]===null?'':e[k]).join('\t')+'\n'; }
function validate(v,k) {
  if(!v || v.schema_version!==1 || v.game!==k.game || v.environment!==k.environment || v.stream_id!==k.streamId)bad('WALLET_SCOPE_MISMATCH',403);
  const common=['schema_version','game','environment','stream_id','type'];
  if(v.type==='wallet.events'){
    if(!exact(v,[...common,'events'])||!Array.isArray(v.events)||v.events.length<1||v.events.length>50)bad('INVALID_WALLET_BATCH');
    const events=v.events.map(event);for(let i=1;i<events.length;i++)if(BigInt(events[i].sequence)<=BigInt(events[i-1].sequence))bad('UNORDERED_WALLET_BATCH');
    return {...v,events};
  }
  if(v.type==='wallet.reconcile'){
    if(!exact(v,[...common,'through_sequence','expected_count','total_balance','player_count','manifest_hash','balances_hash','checked_at','coverage_started_at','commands_enabled'])||!HEX.test(v.manifest_hash)||!HEX.test(v.balances_hash)||typeof v.commands_enabled!=='boolean')bad('INVALID_WALLET_RECONCILIATION');
    integer(v.through_sequence,{max:100000n});integer(v.expected_count,{max:100000n});integer(v.player_count,{max:100000n});integer(v.total_balance,{max:100000000000n});
    if(v.expected_count!==v.through_sequence)bad('WALLET_COUNT_SEQUENCE_MISMATCH');
    return {...v,checked_at:date(v.checked_at,{fresh:true}),coverage_started_at:date(v.coverage_started_at)};
  }
  if(v.type==='wallet.poll') {if(!exact(v,common))bad('INVALID_WALLET_POLL');return v;}
  if(v.type==='wallet.result'){
    const r=v.result,fields=['id','status','reason','ledger_sequence','player_revision','balance_after'];
    if(!exact(v,[...common,'result'])||!exact(r,fields)||!UUID.test(r.id||'')||!['applied','rejected'].includes(r.status))bad('INVALID_WALLET_RESULT');
    if(r.status==='applied'){
      if(r.reason!==null)bad('INVALID_APPLIED_REASON');integer(r.ledger_sequence,{min:1n,max:100000n});integer(r.player_revision,{min:1n,max:100000n});integer(r.balance_after);
    }else{
      if(!['expired','commands_disabled','player_not_found','source_integrity_error','stale_revision','active_round','insufficient_balance','balance_limit'].includes(r.reason)||r.ledger_sequence!==null)bad('INVALID_REJECT_REASON');
      if(r.player_revision!==null)integer(r.player_revision,{min:1n,max:100000n});if(r.balance_after!==null)integer(r.balance_after);
    }
    return v;
  }
  bad('UNKNOWN_WALLET_MESSAGE');
}
module.exports={PATH,UUID,PLAYER,hash,bad,configuration,signature,receiptSignature,authenticate,integer,validate,manifestLine,EVENT_KEYS};
