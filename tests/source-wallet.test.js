'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict'),crypto=require('node:crypto');
const w=require('../engine/source-wallet'),policy=require('../engine/security-policy');
const key={id:'qa-uno',game:'uno-luck',environment:'staging',secret:'ab'.repeat(32)};
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const now=()=>new Date().toISOString();
function packet(){
 const id=crypto.randomUUID(),player='p_'+sha('p1'),e={version:'1',entry_id:'welcome-1',reason:'welcome',delta:'1000',balance_before:'0',balance_after:'1000',occurred_at:now()};
 e.chain_hash=w.entryHash(w.ZERO,e);
 return {schema_version:1,type:'wallet.sync',game:'uno-luck',environment:'staging',stream_id:id,player_ref:player,
  entries:[e],snapshot:{version:'1',balance:'1000',manifest:e.chain_hash,captured_at:now(),commands_enabled:false,active_round:false},receipts:[],requests:[]};
}
test('wallet requires one exact staging UNO key with no duplicate identity',()=>{
 assert.equal(w.configuration(JSON.stringify([key]))[0].game,'uno-luck');
 assert.throws(()=>w.configuration(JSON.stringify([{...key,environment:'production'}])));
 assert.throws(()=>w.configuration(JSON.stringify([key,key])));
 assert.throws(()=>w.configuration(JSON.stringify([{...key,secret:'not-hex'}])));
 assert.deepEqual(w.configuration(undefined),[]);
});
test('signed sender and receipt use separate domains',()=>{
 const raw=Buffer.from('{"a":1}'),ts=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');
 const sig=w.signature(key.secret,ts,nonce,raw);
 const got=w.authenticate({'x-wallet-key':key.id,'x-wallet-time':ts,'x-wallet-nonce':nonce,'x-wallet-signature':sig},raw,[key]);
 assert.equal(got.key.id,key.id);
 assert.match(w.receiptSignature(key.secret,nonce,raw),/^[a-f0-9]{64}$/);
 assert.throws(()=>w.authenticate({'x-wallet-key':key.id,'x-wallet-time':ts,'x-wallet-nonce':nonce,'x-wallet-signature':w.receiptSignature(key.secret,nonce,raw)},raw,[key]));
 assert.throws(()=>w.authenticate({'x-wallet-key':key.id,'x-wallet-time':String(Number(ts)-3600),'x-wallet-nonce':nonce,'x-wallet-signature':sig},raw,[key]));
 assert.throws(()=>w.authenticate({'x-wallet-key':key.id,'x-wallet-time':ts,'x-wallet-nonce':nonce,'x-wallet-signature':sig},Buffer.from('different'),[key]));
});
test('validated source wallet snapshot and immutable entry chain',()=>{
 let p=packet();assert.equal(w.validatePacket(p,key).snapshot.balance,'1000');
 const original=p.entries[0].chain_hash;assert.equal(original,w.entryHash(w.ZERO,p.entries[0]));
 assert.throws(()=>w.validatePacket({...p,environment:'production'},key));
 assert.throws(()=>w.validatePacket({...p,stream_id:'bad'},key));
 assert.throws(()=>w.validatePacket({...p,snapshot:{...p.snapshot,balance:'1000001'}},key));
 assert.throws(()=>w.validatePacket({...p,entries:[{...p.entries[0],delta:1000}]},key));
 assert.throws(()=>w.validatePacket({...p,entries:[...p.entries,...Array(51).fill(p.entries[0])]},key));
});
test('virtual request and command payload are canonical and stage-only',()=>{
 const p=packet();
 p.requests=[{id:crypto.randomUUID(),amount:'100',note:'Please add free credits'}];
 assert.doesNotThrow(()=>w.validatePacket(p,key));
 assert.throws(()=>w.validatePacket({...p,requests:[{...p.requests[0],amount:'100000000000'}]},key));
 const command={id:crypto.randomUUID(),game:'uno-luck',environment:'staging',stream_id:p.stream_id,player_ref:p.player_ref,action:'credit',amount:'100',expected_version:'1',expires_at:new Date(Date.now()+480000).toISOString()};
 assert.equal(w.commandHash(command),sha('gameops.wallet.command.v1\n'+['id','game','environment','stream_id','player_ref','action','amount','expected_version','expires_at'].map(k=>command[k]).join('\n')));
 assert.notEqual(w.commandHash({...command,amount:'101'}),w.commandHash(command));
 assert.throws(()=>w.scope({environment:'production',game:'uno-luck'}));
 assert.doesNotThrow(()=>w.scope({environment:'staging',game:'uno-luck'}));
});
test('CP16 RBAC gives read to support but write to fully enrolled owner only',()=>{
 assert.equal(policy.canAccess('owner','POST','/source-wallet/players/'+crypto.randomUUID()+'/commands'),true);
 assert.equal(policy.canAccess('support','POST','/source-wallet/players/'+crypto.randomUUID()+'/commands'),false);
 assert.equal(policy.canAccess('viewer','GET','/source-wallet/players'),false);
 assert.equal(policy.canAccess('operator','GET','/source-wallet/requests'),true);
 assert.equal(policy.canAccess('owner','POST','/source-wallet/requests/'+crypto.randomUUID()+'/review'),true);
});
