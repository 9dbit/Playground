'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createServer}=require('../server.cjs');
test('static sandbox serves UI directly but exposes no real APIs or private files',async()=>{
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+s.address().port;
 try{
  for(const path of ['/','/engine','/assets/control.js','/assets/control.css','/assets/fixtures.js','/assets/sandbox.css','/assets/parity.css','/assets/admin-ops.css']){const r=await fetch(base+path);assert.equal(r.status,200,path);assert.equal(r.headers.get('set-cookie'),null);await r.text();}
  const health=await fetch(base+'/health');const body=await health.json();assert.equal(body.productionConnected,false);assert.equal(body.apiEnabled,false);
  for(const path of ['/api/admin/summary','/api/auth/session','/.env','/server.cjs','/engine/security.js','/public/control.js']){const r=await fetch(base+path);assert.equal(r.status,404,path);await r.text();}
  const write=await fetch(base+'/api/auth/development',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(write.status,405);assert.equal(write.headers.get('set-cookie'),null);await write.text();
  const page=await fetch(base+'/');assert.match(page.headers.get('content-security-policy'),/connect-src 'none'/);assert.match(await page.text(),/Tidak terhubung produksi/);
 }finally{await new Promise(r=>s.close(r));}
});
test('sandbox refuses production secrets rather than opening a production connection',()=>{const old=process.env.DATABASE_URL;process.env.DATABASE_URL='postgres://synthetic.invalid';try{assert.throws(createServer,/must not receive production credentials/);}finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;}});
