'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const deep=require('../engine/deep-routes');
function harness(){
 const routes={};
 const app={};
 for(const method of ['get','post','put','patch'])app[method]=(path,handler)=>{routes[method+' '+path]=handler};
 deep.mount(app,{pool:{},audit:async()=>{}});
 require('../engine/public-content').mount(app,{pool:{}});
 return routes;
}
function response(){
 return {statusCode:200,payload:null,status(code){this.statusCode=code;return this},json(obj){this.payload=obj;return this}};
}
test('deep admin route coverage',()=>{
 const routes=harness(),names=Object.keys(routes);
 assert.ok(names.length>=26);
 for(const path of ['/api/admin/deep/games/:gid','/api/admin/deep/players/:pid','/api/admin/deep/tickets/:tid','/api/admin/deep/reports/:kind','/api/admin/deep/rounds','/api/admin/deep/content/:kind','/sitemap.xml','/robots.txt']){
  assert.ok(names.some(x=>x.endsWith(' '+path)),'Missing '+path);
 }
});
test('reject malformed game ids without touching storage',async()=>{
 const routes=harness(),res=response();
 await routes['get /api/admin/deep/games/:gid']({params:{gid:'../../etc/passwd'}},res,()=>{throw Error('Unexpected next')});
 assert.equal(res.statusCode,400);
});
test('reject malformed image MIME before database calls',async()=>{
 const routes=harness(),res=response();
 await routes['post /api/admin/deep/games/:gid/image']({params:{gid:'00000000-0000-4000-8000-000000000001'},body:{data:'data:text/plain;base64,AAAA'}},res,error=>{assert.equal(error.status,400);res.status(error.status).json({error:error.message})});
 assert.equal(res.statusCode,400);
});
test('reject unsafe content slug and round ids',async()=>{
 const routes=harness(),res1=response(),res2=response();
 await routes['post /api/admin/deep/content/:kind']({params:{kind:'page'},body:{slug:'../../x',title:'Sample',body:'',status:'draft'}},res1,()=>{throw Error('Unexpected next')});
 await routes['get /api/admin/deep/rounds/:rid']({params:{rid:'-1'}},res2,()=>{throw Error('Unexpected next')});
 assert.equal(res1.statusCode,400);assert.equal(res2.statusCode,400);
});
test('schema migration includes session revocation and audit-support tables',async()=>{
 const sql=[];await deep.ensureSchema({query:async q=>{sql.push(q);return {rows:[]}}});
 assert.ok(sql.some(x=>x.includes('gameops_revoked_sessions')));
 assert.ok(sql.some(x=>x.includes('gameops_login_history')));
 assert.ok(sql.some(x=>x.includes('gameops_game_profiles')));
 assert.ok(sql.some(x=>x.includes('gameops_content')));
});
