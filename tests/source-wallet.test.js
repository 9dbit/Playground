'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const P=require('../engine/source-wallet-protocol');
const {canAccess}=require('../engine/security-policy');
const {requestState,verification}=require('../engine/source-wallet');
const key={id:'qa-wallet',game:'uno-luck',environment:'staging',streamId:crypto.randomUUID(),secret:'d'.repeat(64),allowCommands:true};
const keys=P.configuration(JSON.stringify([key]));
const base={schema_version:1,game:'uno-luck',environment:'staging',stream_id:key.streamId};
const event={sequence:'1',player_sequence:'1',player_ref:'p_'+P.hash('qa-player'),ledger_ref:'l_'+P.hash('qa-ledger'),kind:'welcome',delta:'1000',balance_after:'1000',occurred_at:new Date().toISOString(),command_id:null};
function signed(payload){const raw=Buffer.from(JSON.stringify(payload)),ts=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');return {raw,headers:{'x-wallet-key':key.id,'x-wallet-timestamp':ts,'x-wallet-nonce':nonce,'x-wallet-signature':P.signature(key.secret,ts,nonce,raw)}};}
test('wallet transport domain, signature and strict namespace reject forgery',()=>{
 const s=signed({...base,type:'wallet.events',events:[event]});
 assert.equal(P.authenticate(s.raw,s.headers,keys).key.id,key.id);
 assert.throws(()=>P.authenticate(Buffer.from(s.raw.toString().replace('1000','1001')),s.headers,keys));
 assert.throws(()=>P.authenticate(s.raw,{...s.headers,'x-wallet-timestamp':'1000000000'},keys));
 assert.throws(()=>P.validate({...base,environment:'production',type:'wallet.events',events:[event]},key));
 assert.throws(()=>P.validate({...base,stream_id:crypto.randomUUID(),type:'wallet.events',events:[event]},key));
});
test('wallet key config is explicit and staged command scope only',()=>{
 assert.deepEqual(P.configuration(''),[]);
 assert.throws(()=>P.configuration(JSON.stringify([{...key,environment:'production'}])));
 assert.throws(()=>P.configuration(JSON.stringify([key,key])));
 assert.throws(()=>P.configuration(JSON.stringify([{...key,secret:'admin'}])));
 assert.equal(P.configuration(JSON.stringify([{...key,environment:'production',allowCommands:false}]))[0].allowCommands,false);
});
test('wallet event exact fields, integer types, ranges and sequence',()=>{
 assert.equal(P.validate({...base,type:'wallet.events',events:[event]},key).events[0].delta,'1000');
 for(const change of [{delta:1000},{delta:'1.2'},{balance_after:'-1'},{sequence:'0'},{player_sequence:'-1'},{player_ref:'guest-token'},{secret:'no'}]){
  assert.throws(()=>P.validate({...base,type:'wallet.events',events:[{...event,...change}]},key));
 }
 assert.throws(()=>P.validate({...base,type:'wallet.events',events:[event,event]},key));
 assert.throws(()=>P.validate({...base,type:'wallet.events',events:[{...event,kind:'admin_credit'}]},key));
});
test('wallet receipt is nonce-bound and different from request MAC',()=>{
 const a=Buffer.from('{"accepted":true}');
 assert.notEqual(P.receiptSignature(key.secret,'a'.repeat(32),a),P.receiptSignature(key.secret,'b'.repeat(32),a));
 assert.notEqual(P.receiptSignature(key.secret,'a'.repeat(32),a),P.signature(key.secret,'1','a'.repeat(32),a));
});
test('wallet reconciliation validates exact fields and source capability',()=>{
 const snap={...base,type:'wallet.reconcile',through_sequence:'0',expected_count:'0',total_balance:'0',player_count:'0',manifest_hash:P.hash(''),balances_hash:P.hash(''),checked_at:new Date().toISOString(),coverage_started_at:new Date().toISOString(),commands_enabled:true};
 assert.equal(P.validate(snap,key).commands_enabled,true);
 assert.throws(()=>P.validate({...snap,commands_enabled:'true'},key));
 assert.throws(()=>P.validate({...snap,expected_count:'1'},key));
 assert.throws(()=>P.validate({...snap,checked_at:'2020-01-01T00:00:00.000Z'},key));
});
test('wallet applied receipt requires ledger proof fields, not just approved',()=>{
 const result={id:crypto.randomUUID(),status:'applied',reason:null,ledger_sequence:'2',player_revision:'2',balance_after:'1100'};
 assert.equal(P.validate({...base,type:'wallet.result',result},key).result.status,'applied');
 assert.throws(()=>P.validate({...base,type:'wallet.result',result:{...result,ledger_sequence:null}},key));
 assert.throws(()=>P.validate({...base,type:'wallet.result',result:{...result,status:'approved'}},key));
});
test('wallet role gates: support requests but only owner approves',()=>{
 const id=crypto.randomUUID();
 assert.equal(canAccess('owner','POST','/source-wallet/requests/'+id+'/review'),true);
 assert.equal(canAccess('support','POST','/source-wallet/requests'),true);
 assert.equal(canAccess('support','POST','/source-wallet/requests/'+id+'/review'),false);
 assert.equal(canAccess('operator','POST','/source-wallet/requests'),false);
 assert.equal(canAccess('viewer','GET','/source-wallet/players'),false);
 assert.equal(canAccess('viewer','GET','/source-wallet/requests'),false);
});
test('request state separates approval, delivery and application',()=>{
 assert.equal(requestState({review_status:'pending'}),'pending_approval');
 assert.equal(requestState({review_status:'approved',command_status:'queued'}),'queued');
 assert.equal(requestState({review_status:'approved',command_status:'delivered'}),'awaiting_source_confirmation');
 assert.equal(requestState({review_status:'approved',command_status:'applied'}),'applied');
 assert.equal(requestState({review_status:'approved',command_status:'rejected'}),'rejected_by_source');
 assert.equal(requestState({review_status:'rejected'}),'rejected_by_admin');
});
test('wallet freshness cannot silently promote an outdated balance to matched',()=>{
 const row={reconciliation:'matched',checked_at:new Date().toISOString(),source_checked_at:new Date().toISOString(),through_sequence:'2',received_through:'2'};
 assert.equal(verification(row),'matched');
 assert.equal(verification({...row,source_checked_at:'2020-01-01'}),'stale');
 assert.equal(verification({...row,received_through:'3'}),'new_events_pending');
 assert.equal(verification({...row,reconciliation:'mismatch'}),'mismatch');
});
