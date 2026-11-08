'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {storefrontURL,gameNavigation}=require('../engine/agency/storefront-location');
test('native return address uses registered tenant identity and verified primary domain',async()=>{
 const calls=[],db={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{domain:'agent.example'}]};}};
 assert.equal(await storefrontURL(db,{id:'t',slug:'64cor'},'https://playground.example'),'https://agent.example');
 assert.match(calls[0].sql,/verified_at IS NOT NULL AND is_primary/);assert.deepEqual(calls[0].args,['t']);
});
test('native return fallback is tenant-scoped and label remains text',async()=>{
 const db={query:async()=>({rows:[]})};
 assert.equal(await storefrontURL(db,{id:'t',slug:'64cor'},'https://playground.example'),'https://playground-agent-frontend-production.up.railway.app');
 assert.deepEqual(await gameNavigation(db,{id:'t',slug:'agent-b',name:'Agent B'},'https://playground.example'),{home_url:'https://playground.example/site/agent-b',label:'Agent B'});
});
