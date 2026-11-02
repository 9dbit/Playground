'use strict';
// Actual server.js + PostgreSQL + actual UNO HTTP runtime. No production access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict'),{Pool}=require('pg');
const B=require('../engine/game-bridge'),S=require('../engine/stream-reconciliation');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'test-results','cp15');
const UNO=path.resolve(process.env.UNO_CP15_ROOT||'../uno');
const report={release:'0.15.0',mode:'real-http-source-outbox-receiver-postgresql',productionContacted:false,checks:[],failures:[]};
const keys=[{id:'qa-uno-pilot',game:'uno-luck',environment:'staging',allowRounds:true,secret:crypto.randomBytes(32).toString('hex')},{id:'qa-sky-prod',game:'skygate-5000',environment:'production',allowRounds:true,secret:crypto.randomBytes(32).toString('hex')}];
const creds=new Map();let rootPool,pool,schema,admin,uno,adminEnv,unoEnv,base,gameBase,tmp,adminLog='',unoLog='';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function check(name,fn){const evidence=await fn();report.checks.push({name,status:'PASS',evidence});console.log('CP15_PASS '+name);}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(p){if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),delay(4500)]);if(p.exitCode===null)p.kill('SIGKILL');}
async function wait(fn,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e}await delay(300);}throw Error(label+': '+(last?.message||'timeout'));}
async function startAdmin(){admin=spawn(process.execPath,['server.js'],{cwd:ROOT,env:adminEnv,stdio:['ignore','pipe','pipe']});admin.stdout.on('data',x=>adminLog+=x);admin.stderr.on('data',x=>adminLog+=x);await wait(async()=>{if(admin.exitCode!==null)throw Error('admin exited '+adminLog.slice(-1200));const r=await fetch(base+'/health');return r.ok;},'admin startup');}
async function startUno(){uno=spawn('python',['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',new URL(gameBase).port],{cwd:UNO,env:unoEnv,stdio:['ignore','pipe','pipe']});uno.stdout.on('data',x=>unoLog+=x);uno.stderr.on('data',x=>unoLog+=x);await wait(async()=>{if(uno.exitCode!==null)throw Error('UNO exited '+unoLog.slice(-1800));return (await fetch(gameBase+'/health')).ok;},'UNO startup');}
async function req(endpoint,{method='GET',body,actor='owner'}={}){const c=actor&&creds.get(actor),headers={Origin:base,...(c?{Cookie:c.cookie,'X-CSRF-Token':c.csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})};const r=await fetch(base+endpoint,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={text}}return {status:r.status,data,headers:r.headers};}
async function signed(event,key=keys[0]){const raw=Buffer.from(JSON.stringify(event)),ts=String(Math.floor(Date.now()/1000)),nonce=crypto.randomBytes(16).toString('hex');const headers={'Content-Type':'application/json','X-GameOps-Key':key.id,'X-GameOps-Timestamp':ts,'X-GameOps-Nonce':nonce,'X-GameOps-Signature':B.signature(key.secret,ts,nonce,raw)};const r=await fetch(base+B.PATH,{method:'POST',headers,body:raw});const bytes=Buffer.from(await r.arrayBuffer());if(r.ok)assert.equal(r.headers.get('x-gameops-receipt'),B.receiptSignature(key.secret,nonce,bytes));return {status:r.status,data:JSON.parse(bytes)};}
function sqlite(sql){return JSON.parse(execFileSync('python',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(x) for x in c.execute(sys.argv[2])]))',unoEnv.UNO_SPIN_DB_PATH,sql],{encoding:'utf8'}));}
async function status(){return (await fetch(gameBase+'/api/gameops/status')).json();}
async function runRound(cookie,stake=25){let final;for(let i=0;i<3;i++){const r=await fetch(gameBase+'/api/orbit/pick',{method:'POST',headers:{'Content-Type':'application/json','X-Uno-Client':'spin-ui',Cookie:cookie},body:JSON.stringify({stake,request_id:'cp15_'+crypto.randomBytes(12).toString('hex')})});final=await r.json();assert.equal(r.status,200,JSON.stringify(final));assert.equal(final.round.picked,i+1);}return final;}
async function main(){
 const dbUrl=new URL(process.env.TEST_DATABASE_URL||'http://invalid');assert.ok(['postgres:','postgresql:'].includes(dbUrl.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname));assert.equal(dbUrl.pathname,'/gameops_ci');assert.equal(process.env.CI,'true');assert.ok(fs.existsSync(path.join(UNO,'app/round_outbox.py')));
 fs.mkdirSync(OUT,{recursive:true});tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cp15-uno-'));
 rootPool=new Pool({connectionString:dbUrl.toString()});schema='cp15_'+crypto.randomBytes(8).toString('hex');await rootPool.query('CREATE SCHEMA '+schema);dbUrl.searchParams.set('options','-c search_path='+schema+',public');pool=new Pool({connectionString:dbUrl.toString()});
 const p=await port(),gp=await port();base='http://127.0.0.1:'+p;gameBase='http://127.0.0.1:'+gp;
 const sessionSecret=crypto.randomBytes(48).toString('hex');adminEnv={...process.env,DATABASE_URL:dbUrl.toString(),PORT:String(p),PUBLIC_SITE_URL:base,RAILWAY_PUBLIC_DOMAIN:'',SESSION_SECRET:sessionSecret,ADMIN_USERNAME:'qa_owner',ADMIN_PASSWORD:crypto.randomBytes(32).toString('base64url'),NODE_ENV:'test',GAMEOPS_BRIDGE_KEYS:JSON.stringify([keys[1]]),GAMEOPS_ADDITIONAL_KEYS:JSON.stringify([keys[0]])};
 unoEnv={...process.env,CI:'true',GAMEOPS_TEST_MODE:'1',GAMEOPS_ROUNDS_ENABLED:'1',GAMEOPS_BRIDGE_ENABLED:'0',GAMEOPS_BRIDGE_KEY_ID:keys[0].id,GAMEOPS_BRIDGE_SECRET:keys[0].secret,GAMEOPS_ENVIRONMENT:'staging',GAMEOPS_RECEIVER_URL:base+B.PATH,UNO_SPIN_DB_PATH:path.join(tmp,'game.sqlite3'),UNO_SOUND_STORAGE_DIR:'',PYTHONUNBUFFERED:'1'};
 await startAdmin();await startUno();
 const own=(await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='qa_owner' RETURNING id,password_hash")).rows[0];
 for(const role of ['owner','viewer']){const id=role==='owner'?own.id:(await pool.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash,must_change_password,mfa_enabled) VALUES('qa_viewer','QA Viewer','viewer',$1,false,true) RETURNING id",[own.password_hash])).rows[0].id;const raw=crypto.randomBytes(32).toString('base64url');await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '2 hours')",[id,sha(raw)]);creds.set(role,{raw,cookie:'gameops_session='+raw,csrf:crypto.createHmac('sha256',sessionSecret).update('cp08:csrf:'+raw).digest('base64url')});}
 const game=(await pool.query("SELECT id FROM gameops_games WHERE slug='uno-luck'")).rows[0].id;
 await pool.query("INSERT INTO gameops_events(game_id,event_id,round_id,player_ref,stake,payout,occurred_at) VALUES($1,'legacy-keep','legacy-keep','legacy-player',777,333,now())",[game]);
 const guestRes=await fetch(gameBase+'/api/orbit/state');const cookie=guestRes.headers.get('set-cookie').split(';')[0];assert.ok(cookie.startsWith('ul_spin_guest='));
 let first;
 await check('completed round capture, actual server amounts, no early event',async()=>{
  for(let i=0;i<2;i++){const r=await fetch(gameBase+'/api/orbit/pick',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Uno-Client':'spin-ui'},body:JSON.stringify({request_id:'cp15_'+crypto.randomBytes(12).toString('hex'),stake:25})});assert.equal(r.status,200);}
  assert.equal((await status()).queued_total,0);
  const r=await fetch(gameBase+'/api/orbit/pick',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Uno-Client':'spin-ui'},body:JSON.stringify({request_id:'cp15_'+crypto.randomBytes(12).toString('hex'),stake:25})});first=await r.json();assert.equal(r.status,200);assert.equal(first.round.complete,true);
  await wait(async()=>{const s=await status();return s.acknowledged===1&&s.reconciliation==='matched'&&s.reconciled_through==='1'},'first receipt and manifest');
  const source=sqlite('SELECT id,stake,payout,delta FROM spins');assert.equal(source.length,1);assert.equal(source[0].id,first.round.id);
  const got=(await req('/api/admin/data/rounds?environment=staging&game=uno-luck')).data.items;
  assert.equal(got.length,1);assert.equal(got[0].source_round_id,source[0].id);assert.equal(got[0].stake,source[0].stake+'.000000000000');assert.equal(got[0].payout,(source[0].stake+source[0].delta)+'.000000000000');
  assert.match(got[0].player_ref,/^p_[a-f0-9]{64}$/);assert.equal(JSON.stringify(got).includes(cookie.split('=')[1]),false);
  return {rounds:1,sourceAndReceivedAmountsEqual:true,manifest:'matched',earlyCapture:false};
 });
 await check('staging never contributes to production or legacy counters',async()=>{
  const prod=await req('/api/admin/data/summary'),stage=await req('/api/admin/data/summary?environment=staging&game=uno-luck');
  assert.equal(prod.data.rounds,'0');assert.equal(stage.data.rounds,'1');assert.equal(stage.data.legacy.records,'1');assert.equal(stage.data.legacy.included,false);
  const legacy=(await req('/api/admin/summary')).data;assert.equal(legacy.rounds,1);assert.equal(legacy.stake,'777');
  return {productionRounds:'0',stagingRounds:'1',legacyRounds:1,legacyNotBlended:true};
 });
 await check('receiver outage and source restart retain durable pending delivery',async()=>{
  await stop(admin);admin=null;await runRound(cookie);await runRound(cookie);
  await wait(async()=>{const s=await status();return s.queued_total===3&&s.pending>=2&&s.retrying>0},'durable pending rows');
  await stop(uno);uno=null;await startUno();const restored=await status();assert.equal(restored.queued_total,3);
  await startAdmin();await wait(async()=>{const s=await status();return s.acknowledged===3&&s.reconciliation==='matched'&&s.reconciled_through==='3'},'retry and reconciliation',60000);
  const source=sqlite('SELECT id,stake,delta FROM spins');const summary=(await req('/api/admin/data/summary?environment=staging&game=uno-luck')).data;
  assert.equal(summary.rounds,'3');assert.equal(summary.stake,source.reduce((a,x)=>a+x.stake,0)+'.000000000000');assert.equal(summary.payout,source.reduce((a,x)=>a+x.stake+x.delta,0)+'.000000000000');
  return {queuedSurvivedRestart:true,rounds:'3',exactTotals:true,sourceReceiverManifest:'matched'};
 });
 await check('event duplicate, conflict and forged signatures do not mutate results',async()=>{
  const payload=JSON.parse(sqlite('SELECT payload FROM gameops_round_outbox ORDER BY sequence LIMIT 1')[0].payload);
  const repeat=await signed(payload);assert.equal(repeat.status,200);assert.equal(repeat.data.duplicate,true);
  const conflict=await signed({...payload,payout:String(Number(payload.payout)+1)});assert.equal(conflict.status,409);
  const wrong=await signed({...payload,environment:'production'});assert.equal(wrong.status,403);
  const invalid=await fetch(base+B.PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(invalid.status,401);
  assert.equal((await req('/api/admin/data/summary?environment=staging')).data.rounds,'3');
  return {duplicate:'acknowledged_no_double_count',conflict:409,wrongScope:403,unsigned:401};
 });
 let decimalRound,observedPlayer;
 await check('exact decimal data and out-of-order reconciliation use a separate production scope',async()=>{
  const stream=crypto.randomUUID(),key=keys[1],events=[1,2].map(n=>({schema_version:2,type:'round.settled',game:key.game,environment:key.environment,event_id:'qa-exact-'+n,round_id:'qa-exact-'+n,player_ref:'p_'+sha('qa-exact-player'),currency:'DEMO_COIN',stake:n===1?'0.000000000001':'9007199254740993.000000000001',payout:n===1?'0.000000000003':'9007199254740993.000000000005',occurred_at:new Date().toISOString(),stream_id:stream,source_sequence:String(n)}));
  const normalized=events.map(e=>({source_sequence:e.source_sequence,source_event_id:e.event_id,source_round_id:e.round_id,player_ref:e.player_ref,stake:B.decimal(e.stake),payout:B.decimal(e.payout),occurred_at:e.occurred_at}));
  const snap={schema_version:2,type:'source.reconcile',game:key.game,environment:key.environment,stream_id:stream,through_sequence:'2',expected_count:'2',stake:'9007199254740993.000000000002',payout:'9007199254740993.000000000008',manifest_hash:sha(normalized.map(S.manifestLine).join('')),occurred_at:new Date().toISOString()};
  assert.equal((await signed(events[1],key)).status,200);const miss=await signed(snap,key);assert.equal(miss.data.status,'mismatch');assert.equal(miss.data.received_count,'1');
  assert.equal((await signed(events[0],key)).status,200);const match=await signed(snap,key);assert.equal(match.data.status,'matched');
  const changed=await signed({...snap,stake:'1'},key);assert.equal(changed.status,409);
  const total=(await req('/api/admin/data/summary')).data;assert.equal(total.rounds,'2');assert.equal(total.stake,snap.stake);assert.equal(total.payout,snap.payout);
  const stage=(await req('/api/admin/data/summary?environment=staging')).data;assert.equal(stage.rounds,'3');
  const rows=(await req('/api/admin/data/rounds?environment=production')).data.items;decimalRound=rows[0];observedPlayer=rows[0].player_id;
  return {delayedEventMatched:true,manifestMatched:true,decimalPrecisionPreserved:true,productionRounds:'2',stagingRounds:'3'};
 });
 await check('authorization, scoping, cursor paging and immutable records',async()=>{
  assert.equal((await req('/api/admin/data/summary',{actor:null})).status,401);
  assert.equal((await req('/api/admin/data/players',{actor:'viewer'})).status,403);
  const visible=(await req('/api/admin/data/rounds',{actor:'viewer'})).data.items;assert.ok(visible.length>0);assert.equal(Object.hasOwn(visible[0],'player_ref'),false);
  assert.equal((await req('/api/admin/data/rounds/'+decimalRound.id+'?environment=staging')).status,404);
  assert.equal((await req('/api/admin/data/players/'+observedPlayer+'?environment=staging')).status,404);
  for(const q of ['environment=unknown','game=unknown','q[x]=1','limit=101','before=-1','player=bad'])assert.equal((await req('/api/admin/data/rounds?'+q)).status,400,q);
  const a=(await req('/api/admin/data/rounds?environment=staging&limit=1')).data;const b=(await req('/api/admin/data/rounds?environment=staging&limit=1&before='+a.next_cursor)).data;assert.notEqual(a.items[0].id,b.items[0].id);
  assert.equal((await req('/api/admin/data/rounds/'+decimalRound.id,{method:'PUT',body:{payout:'999'}})).status,403);
  return {anonymous:401,viewerPlayerDenied:403,wrongScope:404,writeDenied:403,pagination:'distinct'};
 });
 await check('real HTTP browser data dashboard and drilldowns without mocked responses',async()=>{
  const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});
  try{const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'gameops_session',value:creds.get('owner').raw,url:base,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   const scope='environment=staging&game=uno-luck';await page.goto(base+'/data?'+scope);await page.getByRole('heading',{name:'Game summary'}).waitFor();assert.match(await page.locator('#notice').innerText(),/STAGING/);
   await page.locator('#tabs [data-tab=rounds]').click();await page.getByRole('heading',{name:'Game Log / staging'}).waitFor();assert.equal(await page.locator('tbody tr').count(),3);
   await page.locator('tbody tr td:first-child a').first().click();await page.getByRole('heading',{name:/Observed round/}).waitFor();assert.match(await page.locator('#content').innerText(),/Immutable observation/);
   await page.locator('#tabs [data-tab=players]').click();await page.getByRole('heading',{name:/Observed Players/}).waitFor();await page.locator('tbody a').first().click();await page.getByRole('heading',{name:'Observed Player Detail'}).waitFor();assert.match(await page.locator('#content').innerText(),/No verified email/);
   await page.getByRole('link',{name:"View this player's observed rounds"}).click();await page.getByRole('heading',{name:'Game Log / staging'}).waitFor();assert.equal(await page.locator('tbody tr').count(),3);
   await page.locator('#tabs [data-tab=reconciliation]').click();await page.getByRole('heading',{name:'Source-to-receiver reconciliation'}).waitFor();await page.getByText('prefix_matched',{exact:true}).waitFor();
   await page.screenshot({path:path.join(OUT,'data-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(OUT,'data-mobile.png'),fullPage:true});assert.deepEqual(errors,[]);
   await page.goto(base+'/engine');await page.getByRole('heading',{name:'Production Game Data'}).waitFor();assert.equal(await page.getByRole('link',{name:'Game Data / Reconciliation'}).count(),1);
   return {apiMocked:false,desktop:true,mobile390:true,scopedDrilldowns:true,errors:0};
  }finally{await browser.close()}
 });
 await check('final reconciliation and durable receiver restart preserve accepted source rows',async()=>{
  await stop(admin);admin=null;await startAdmin();const total=(await req('/api/admin/data/summary?environment=staging')).data;assert.equal(total.rounds,'3');
  await wait(async()=>{const s=await status();return s.reconciliation==='matched'&&s.acknowledged===3},'reconcile after receiver restart');
  const r=(await req('/api/admin/data/reconciliations?environment=staging&game=uno-luck')).data.items[0];assert.equal(r.expected_count,'3');assert.equal(r.received_count,'3');assert.equal(r.expected_manifest,r.received_manifest);
  const wallets=(await pool.query('SELECT count(*)::int AS n FROM gameops_virtual_wallet_operations')).rows[0].n;assert.equal(wallets,0);
  return {receiverRestart:true,rows:3,manifestEqual:true,walletMutations:0};
 });
 report.result='PASS';report.finishedAt=new Date().toISOString();
}
main().catch(e=>{report.result='FAIL';report.failures.push({message:e.message,stack:e.stack});console.error(e);process.exitCode=1}).finally(async()=>{await stop(uno);await stop(admin);if(pool)await pool.end();if(rootPool){if(schema)await rootPool.query('DROP SCHEMA '+schema+' CASCADE');await rootPool.end();}if(tmp)fs.rmSync(tmp,{recursive:true,force:true});fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(OUT,'runtime.log'),adminLog+'\nUNO\n'+unoLog);console.log(JSON.stringify(report));});
