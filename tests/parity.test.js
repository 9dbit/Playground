'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inventory,mount}=require('../engine/parity');
test('parity inventory covers every main group and all 19 settings',()=>{
 const rows=inventory(),groups=rows.filter(x=>x.kind==='root'),settings=rows.filter(x=>x.kind==='setting');
 assert.equal(groups.length,10);
 assert.equal(settings.length,19);
 assert.ok(rows.length>=70);
 assert.equal(new Set(rows.map(x=>x.id)).size,rows.length);
 for(const x of rows){
  assert.ok(x.group&&x.name&&x.route);
  assert.ok(['navigation','partial','blocked','implemented'].includes(x.status));
  assert.equal(x.route.startsWith('/'),false);
 }
 assert.ok(rows.find(x=>x.name==='Login as User').status==='blocked');
 assert.ok(rows.find(x=>x.name==='Transfer History'));
});
test('parity API explicitly reports blocked integrations and source evidence',async()=>{
 const routes={get(path,handler){routes[path]=handler}};
 mount(routes,{pool:{query:async()=>({rows:[{wallets:null,wallet_entries:null,admin_accounts:'gameops_admin_accounts',game_profiles:'gameops_game_profiles',wallet_operations:null}]})}});
 let result;await routes['/api/admin/parity']({}, {json(x){result=x}},()=>{throw Error('should not error')});
 assert.equal(result.service.virtualWallet,false);
 assert.equal(result.service.externalGameWallet,false);
 assert.equal(result.service.paymentProvider,false);
 assert.ok(result.counts.blocked>0);
 assert.match(result.assessment,/not proof/);
});
