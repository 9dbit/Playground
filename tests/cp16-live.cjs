'use strict';
// CP16 disposable actual HTTP + PostgreSQL + UNO SQLite wallet acceptance.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises'),{Pool}=require('pg');
const ROOT=path.resolve(__dirname,'..'),UNO=path.resolve(process.env.UNO_CP15_ROOT||'./uno-source'),OUT=path.join(ROOT,'test-results','cp16');
const report={cp:'16',source:'real-unmodified-gameplay-plus-staging-wallet',productionContacted:false,checks:[],failures:[],result:'pending'};
const secret=()=>crypto.randomBytes(32).toString('hex'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const walletKey={id:'ci-wallet-staging',game:'uno-luck',environment:'staging',secret:secret()};
const bridgeKey={id:'ci-round-staging',game:'uno-luck',environment:'staging',allowRounds:true,secret:secret()};
let rootPool,pool,schema,uno,admin,adminEnv,unoEnv,adminUrl,unoUrl,tmp,sessionSecret,cookie,csrf,logs='';
function check(name,evidence){report.checks.push({name,status:'PASS',evidence});console.log('CP16_PASS '+name)}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function stop(p){if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),delay(4000)]);if(p.exitCode===null)p.kill('SIGKILL')}
async function wait(fn,name,ms=35000){let e,last;const until=Date.now()+ms;while(Date.now()<until){try{const x=await fn();if(x)return x;}catch(err){e=err}await delay(350)}throw Error('Timeout: '+name+' '+(e?.message||last||''))}
async function startAdmin(){
 admin=spawn(process.execPath,['server.js'],{cwd:ROOT,env:adminEnv,stdio:['ignore','pipe','pipe']});
 admin.stdout.on('data',x=>logs+=x);admin.stderr.on('data',x=>logs+=x);
 await wait(async()=>{if(admin.exitCode!==null)throw Error('Admin died '+logs.slice(-1600));return (await fetch(adminUrl+'/health')).ok},'admin startup');
}
async function startUno(){
 uno=spawn('python',['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',new URL(unoUrl).port],{cwd:UNO,env:unoEnv,stdio:['ignore','pipe','pipe']});
 uno.stdout.on('data',x=>logs+=x);uno.stderr.on('data',x=>logs+=x);
 await wait(async()=>{if(uno.exitCode!==null)throw Error('UNO died '+logs.slice(-1600));return (await fetch(unoUrl+'/health')).ok},'UNO startup');
}
async function request(url,{method='GET',body,guest=false,asOwner=true,noCsrf=false}={}){
 const headers={...(body!==undefined?{'Content-Type':'application/json'}:{}),...(asOwner?{Cookie:cookie,'X-CSRF-Token':noCsrf?'invalid':csrf,Origin:adminUrl}:{}),...(guest?{Cookie:guest,'X-Uno-Client':'spin-ui'}:{})};
 const r=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(12000)});
 let j;const raw=await r.text();try{j=JSON.parse(raw)}catch{j={raw}};
 return {status:r.status,data:j,headers:r.headers};
}
const adminAPI=(p,opts={})=>request(adminUrl+'/api/admin/source-wallet/'+p+'?environment=staging&game=uno-luck',opts);
function sqlite(sql){
 return JSON.parse(execFileSync('python',['-c','import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row;print(json.dumps([dict(row) for row in db.execute(sys.argv[2])]))',unoEnv.UNO_SPIN_DB_PATH,sql],{encoding:'utf8'}));
}
async function expectCommand(id,state,timeout=40000){
 return wait(async()=>{const q=await pool.query("SELECT state,source_code,source_version::text,source_balance::text FROM gameops_source_wallet_commands WHERE id=$1",[id]);return q.rows[0]?.state===state?q.rows[0]:null},'command '+id+' '+state,timeout);
}
async function main(){
 assert.equal(process.env.CI,'true');const url=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
 assert.ok(['postgresql:','postgres:'].includes(url.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/gameops_ci');
 assert.ok(fs.existsSync(path.join(UNO,'app/wallet_link.py')),'Actual UNO CP16 source required');
 tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cp16-wallet-'));fs.mkdirSync(OUT,{recursive:true});
 rootPool=new Pool({connectionString:url.toString()});schema='cp16_'+crypto.randomBytes(7).toString('hex');await rootPool.query('CREATE SCHEMA '+schema);
 url.searchParams.set('options','-c search_path='+schema+',public');pool=new Pool({connectionString:url.toString()});
 adminUrl='http://127.0.0.1:'+await port();unoUrl='http://127.0.0.1:'+await port();sessionSecret=secret()+secret();
 adminEnv={...process.env,DATABASE_URL:url.toString(),PORT:String(new URL(adminUrl).port),NODE_ENV:'test',PUBLIC_SITE_URL:adminUrl,RAILWAY_PUBLIC_DOMAIN:'',SESSION_SECRET:sessionSecret,ADMIN_USERNAME:'cp16_owner',ADMIN_PASSWORD:secret(),GAMEOPS_ADDITIONAL_KEYS:JSON.stringify([bridgeKey]),GAMEOPS_BRIDGE_KEYS:'[]',GAMEOPS_WALLET_KEYS:JSON.stringify([walletKey]),GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED:'1'};
 unoEnv={...process.env,CI:'true',PYTHONUNBUFFERED:'1',GAMEOPS_TEST_MODE:'1',GAMEOPS_BRIDGE_ENABLED:'0',GAMEOPS_ROUNDS_ENABLED:'1',GAMEOPS_BRIDGE_KEY_ID:bridgeKey.id,GAMEOPS_BRIDGE_SECRET:bridgeKey.secret,GAMEOPS_ENVIRONMENT:'staging',GAMEOPS_RECEIVER_URL:adminUrl+'/api/v2/game-bridge',GAMEOPS_WALLET_ENABLED:'1',GAMEOPS_WALLET_COMMANDS_ENABLED:'1',GAMEOPS_WALLET_KEY_ID:walletKey.id,GAMEOPS_WALLET_SECRET:walletKey.secret,GAMEOPS_WALLET_RECEIVER:adminUrl+'/api/v3/wallet-sync',UNO_SPIN_DB_PATH:path.join(tmp,'wallet.sqlite3'),UNO_SOUND_STORAGE_DIR:''};
 await startAdmin();await startUno();
 const own=(await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='cp16_owner' RETURNING id")).rows[0];
 const token=crypto.randomBytes(32).toString('base64url');cookie='gameops_session='+token;
 csrf=crypto.createHmac('sha256',sessionSecret).update('cp08:csrf:'+token).digest('base64url');
 await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '90 minutes')",[own.id,sha(token)]);
 const stage='?environment=staging&game=uno-luck';
 const guest=await request(unoUrl+'/api/orbit/state',{asOwner:false});
 assert.equal(guest.status,200);const guestCookie=guest.headers.get('set-cookie').split(';')[0];assert.ok(guestCookie.startsWith('ul_spin_guest='));
 const wallet=await wait(async()=>{const data=await adminAPI('players');return data.status===200&&data.data.items.length===1&&data.data.items[0].reconciliation==='matched'?data.data.items[0]:null},'initial signed source wallet',45000);
 assert.equal(wallet.balance,'1000');assert.equal(wallet.version,'1');check('initial source wallet from real welcome ledger',{balance:wallet.balance,version:wallet.version,matched:true});
 const noAuth=await adminAPI('players',{asOwner:false});assert.equal(noAuth.status,401);
 const unsigned=await request(adminUrl+'/api/v3/wallet-sync',{method:'POST',asOwner:false,body:{type:'wallet.sync'}});assert.equal(unsigned.status,401);
 const wrong=await request(adminUrl+'/api/admin/source-wallet/players?environment=production&game=uno-luck');assert.equal(wrong.status,400);
 const badCsrf=await adminAPI('players/'+wallet.id+'/commands',{method:'POST',noCsrf:true,body:{id:crypto.randomUUID(),action:'credit',amount:'10',reason:'Unauthenticated edit test',expected_version:wallet.version}});assert.equal(badCsrf.status,403);
 check('scope, signature, session and CSRF restrictions',{anonymous:401,unsigned:401,productionScope:400,csrf:403});
 const rid=crypto.randomUUID(),reqBody={request_id:rid,amount:100,note:'Free virtual credit request for QA'};
 const ask=await request(unoUrl+'/api/gameops/wallet-request',{method:'POST',asOwner:false,guest:guestCookie,body:reqBody});
 assert.equal(ask.status,200,JSON.stringify(ask.data));assert.equal(ask.data.balance_changed,false);
 const repeat=await request(unoUrl+'/api/gameops/wallet-request',{method:'POST',asOwner:false,guest:guestCookie,body:reqBody});
 assert.equal(repeat.status,200);assert.equal(repeat.data.replay,true);
 const sourceRequest=await wait(async()=>{let d=await adminAPI('requests');return d.data.items.find(x=>x.id===ask.data.request_id&&x.state==='pending')},'pseudonymous source credit request');
 assert.equal(sourceRequest.amount,'100');assert.equal(sourceRequest.wallet_id,wallet.id);
 check('guest request transferred without balance change',{requestId:ask.data.request_id,amount:100,replayNoDuplicate:true});
 const cid=crypto.randomUUID();
 const review=await adminAPI('requests/'+ask.data.request_id+'/review',{method:'POST',body:{decision:'approve',command_id:cid,reason:'QA virtual credit promotion'}});
 assert.equal(review.status,202,JSON.stringify(review.data));assert.equal(review.data.balanceChanged,false);
 const applied=await expectCommand(cid,'applied',45000);assert.equal(applied.source_code,'ok');
 const detail=(await adminAPI('players/'+wallet.id)).data;
 assert.equal(detail.item.balance,'1100');assert.equal(detail.item.version,'2');assert.equal(detail.entries.filter(x=>x.reason==='admin_credit').length,1);
 const local=sqlite("SELECT balance FROM accounts");assert.equal(local[0].balance,1100);
 assert.equal(sqlite("SELECT count(*) AS n FROM ledger WHERE reason='admin_credit'")[0].n,1);
 assert.equal((await adminAPI('requests')).data.items.find(x=>x.id===ask.data.request_id).state,'applied');
 const twice=await adminAPI('requests/'+ask.data.request_id+'/review',{method:'POST',body:{decision:'approve',command_id:cid,reason:'QA virtual credit promotion'}});
 assert.equal(twice.status,409);
 check('owner approved request applied once only after source ledger proof',{sourceBalance:1100,command:cid,receipt:'applied',duplicateReview:409});
 const debit=crypto.randomUUID();const dd=await adminAPI('players/'+wallet.id+'/commands',{method:'POST',body:{id:debit,action:'debit',amount:'25',expected_version:'2',reason:'QA debit balance safety'}});
 assert.equal(dd.status,202);assert.equal(dd.data.balanceChanged,false);assert.equal((await expectCommand(debit,'applied')).source_code,'ok');
 let now=(await adminAPI('players/'+wallet.id)).data.item;assert.equal(now.balance,'1075');assert.equal(now.version,'3');
 const badDebit=crypto.randomUUID();
 const fail=await adminAPI('players/'+wallet.id+'/commands',{method:'POST',body:{id:badDebit,action:'debit',amount:'10000',expected_version:'3',reason:'QA insufficient balance test'}});
 assert.equal(fail.status,202);const rejected=await expectCommand(badDebit,'failed');assert.equal(rejected.source_code,'insufficient_balance');
 now=(await adminAPI('players/'+wallet.id)).data.item;assert.equal(now.balance,'1075');assert.equal(sqlite("SELECT balance FROM accounts")[0].balance,1075);
 check('debit and insufficient balance proven on source ledger',{appliedDebit:25,failedDebit:10000,balance:'1075',noNegativeBalance:true});
 const q1=await adminAPI('players/'+wallet.id+'/commands',{method:'POST',body:{id:crypto.randomUUID(),action:'credit',amount:'50',expected_version:'2',reason:'QA stale account version test'}});
 assert.equal(q1.status,409);check('stale version cannot create queued command',{status:409});
 await stop(uno);uno=null;await startUno();
 await wait(async()=>{let x=(await adminAPI('players/'+wallet.id)).data.item;return x.reconciliation==='matched'&&x.balance==='1075'},'post restart source mirror');
 assert.equal(sqlite("SELECT count(*) AS n FROM ledger WHERE reason='admin_credit'")[0].n,1);
 check('persisted source restart remains exactly reconciled',{balance:'1075',duplicatedCredits:0});
 const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});
 try{const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addCookies([{name:'gameops_session',value:token,url:adminUrl,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(adminUrl+'/wallet');await page.getByRole('heading',{name:/Source Wallet/}).waitFor();
  await page.getByRole('heading',{name:'UNO Pilot Players'}).waitFor();
  await page.locator('#content tbody tr a').first().click();await page.getByRole('heading',{name:/Source Balance/}).waitFor();
  await page.getByRole('heading',{name:'Source Transaction History'}).waitFor();
  await page.getByRole('heading',{name:'Administrative Commands'}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(OUT,'wallet-mobile.png'),fullPage:true});
  await page.locator('#tabs a[data-tab=requests]').click();await page.getByRole('heading',{name:/Diamond Requests/}).waitFor();
  assert.deepEqual(errors,[]);check('real browser UI with source history and request status',{mobile390:true,jsErrors:0,sourceApiMocked:false});
 }finally{await browser.close();}
 report.result='PASS';
}
main().catch(e=>{report.result='FAIL';report.failures.push({message:e.message,stack:e.stack});console.error(e);process.exitCode=1}).finally(async()=>{
 await stop(uno);await stop(admin);if(pool)await pool.end();
 if(rootPool){if(schema)await rootPool.query('DROP SCHEMA '+schema+' CASCADE');await rootPool.end();}
 if(tmp)fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(OUT,{recursive:true});
 report.finishedAt=new Date().toISOString();
 fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(OUT,'runtime.log'),logs.slice(-25000));
 console.log(JSON.stringify(report));
});
