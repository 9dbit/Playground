'use strict';
// Actual server.js + actual UNO/FastAPI + real PostgreSQL/SQLite. No API mocks.
// Every account, key and failure trigger exists only in an isolated loopback CI schema.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),os=require('node:os');
const {spawn,execFileSync}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict'),{Pool}=require('pg'),P=require('../engine/source-wallet-protocol');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'test-results','cp16');
const UNO=path.resolve(process.env.UNO_CP16_ROOT||'../uno');
const report={release:'0.16.0',mode:'actual-source-authority-command-ledger-real-http',productionContacted:false,checks:[],failures:[]};
const bridgeKey={id:'qa-uno-rounds',game:'uno-luck',environment:'staging',allowRounds:true,secret:crypto.randomBytes(32).toString('hex')};
let walletKey={id:'qa-uno-wallet',game:'uno-luck',environment:'staging',allowCommands:true,secret:crypto.randomBytes(32).toString('hex'),streamId:null};
const creds=new Map(),SCOPE='?environment=staging&game=uno-luck',PREFIX='/api/admin/source-wallet/';
let rootPool,pool,schema,admin,uno,adminEnv,unoEnv,base,gameBase,tmp,adminLog='',unoLog='',cookie,accountId,sourcePlayer;
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function check(name,fn){const evidence=await fn();report.checks.push({name,status:'PASS',evidence});console.log('CP16_PASS '+name);}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function stop(p){if(!p||p.exitCode!==null)return;p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),delay(4500)]);if(p.exitCode===null)p.kill('SIGKILL');}
async function wait(fn,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e}await delay(250);}throw Error(label+': '+(last?.message||'timeout'));}
async function startAdmin(){admin=spawn(process.execPath,['server.js'],{cwd:ROOT,env:adminEnv,stdio:['ignore','pipe','pipe']});admin.stdout.on('data',x=>adminLog+=x);admin.stderr.on('data',x=>adminLog+=x);await wait(async()=>{if(admin.exitCode!==null)throw Error('admin exited '+adminLog.slice(-1600));return (await fetch(base+'/health')).ok},'admin startup');}
async function startUno(){uno=spawn('python',['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',new URL(gameBase).port],{cwd:UNO,env:unoEnv,stdio:['ignore','pipe','pipe']});uno.stdout.on('data',x=>unoLog+=x);uno.stderr.on('data',x=>unoLog+=x);await wait(async()=>{if(uno.exitCode!==null)throw Error('UNO exited '+unoLog.slice(-2000));return (await fetch(gameBase+'/health')).ok;},'UNO startup');}
async function req(endpoint,{method='GET',body,actor='owner',noCsrf=false}={}){
 const c=actor&&creds.get(actor),headers={Origin:base,...(c?{Cookie:c.cookie,...(!noCsrf?{'X-CSRF-Token':c.csrf}:{})}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})};
 const r=await fetch(base+endpoint,{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch{data={text}}return {status:r.status,data};
}
async function gameReq(endpoint,body){const r=await fetch(gameBase+endpoint,{method:body!==undefined?'POST':'GET',headers:{Cookie:cookie||'','Content-Type':'application/json','X-Uno-Client':'spin-ui'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
function py(code,extra={}){return execFileSync('python',['-c',code],{cwd:UNO,env:{...unoEnv,...extra},encoding:'utf8'}).trim();}
function sqlite(sql,args=[]){return JSON.parse(execFileSync('python',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(x) for x in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))',unoEnv.UNO_SPIN_DB_PATH,sql,JSON.stringify(args)],{encoding:'utf8'}));}
const sourceBalance=()=>sqlite('SELECT balance FROM accounts WHERE id=?',[accountId])[0].balance;
async function sourceStatus(){return (await fetch(gameBase+'/api/gameops/wallet-status')).json();}
async function matched(){await wait(async()=>{const s=await sourceStatus();return s.enabled&&s.pending_events===0&&s.reconciliation==='matched'&&s.through_sequence===String(s.source_events)},'wallet source reconciliation',60000);}
async function detail(){const r=await req(PREFIX+'players/'+sourcePlayer+SCOPE);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function fresh(){await matched();await wait(async()=>{const d=await detail();return d.item.verification==='matched'&&Number(d.item.balance)===sourceBalance()},'receiver source balance readback');}
async function createRequest(action='credit',amount='25',actor='owner',overrides={}){
 const body={player_id:sourcePlayer,action,amount,reason:'QA authorized virtual credits only',idempotency_key:crypto.randomUUID(),...overrides};
 const r=await req(PREFIX+'requests'+SCOPE,{method:'POST',body,actor});return {...r,body};
}
async function review(id,{decision='approve',version=1,actor='owner',note='QA reviewed virtual source request'}={}){return req(PREFIX+'requests/'+id+'/review'+SCOPE,{method:'POST',actor,body:{decision,version,note}});}
async function result(id){const r=await req(PREFIX+'requests/'+id+SCOPE);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.item;}
async function terminal(id){return wait(async()=>{const r=await result(id);return ['applied','rejected_by_source','rejected_by_admin'].includes(r.state)&&r},'terminal source command',60000);}
async function runRound(){let last;for(let i=0;i<3;i++)last=await gameReq('/api/orbit/pick',{stake:25,request_id:'cp16_'+crypto.randomBytes(12).toString('hex')});return last;}
async function failAudit(action){
 if(!action){await pool.query('DROP TRIGGER IF EXISTS cp16_force_audit_failure ON gameops_audit');await pool.query('DROP FUNCTION IF EXISTS cp16_fail_audit()');return;}
 assert.match(action,/^[a-z_.]+$/);
 await pool.query(`CREATE OR REPLACE FUNCTION cp16_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'CP16 isolated audit failure'; END IF; RETURN NEW; END $$`);
 await pool.query('DROP TRIGGER IF EXISTS cp16_force_audit_failure ON gameops_audit');
 await pool.query('CREATE TRIGGER cp16_force_audit_failure BEFORE INSERT ON gameops_audit FOR EACH ROW EXECUTE FUNCTION cp16_fail_audit()');
}
async function signed(message,options={}){
 const raw=Buffer.from(JSON.stringify(message)),ts=String(Math.floor(Date.now()/1000)),nonce=options.nonce||crypto.randomBytes(16).toString('hex');
 const headers={'Content-Type':'application/json','X-Wallet-Key':walletKey.id,'X-Wallet-Timestamp':ts,'X-Wallet-Nonce':nonce,'X-Wallet-Signature':P.signature(walletKey.secret,ts,nonce,raw)};
 if(options.forged)headers['X-Wallet-Signature']='0'.repeat(64);
 const r=await fetch(base+P.PATH,{method:'POST',headers,body:raw});const bytes=Buffer.from(await r.arrayBuffer());
 if(r.ok)assert.equal(r.headers.get('x-wallet-receipt'),P.receiptSignature(walletKey.secret,nonce,bytes));
 return {status:r.status,data:JSON.parse(bytes)};
}
async function main(){
 const dbUrl=new URL(process.env.TEST_DATABASE_URL||'http://invalid');assert.ok(['postgres:','postgresql:'].includes(dbUrl.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(dbUrl.hostname));assert.equal(dbUrl.pathname,'/gameops_ci');assert.equal(process.env.CI,'true');assert.ok(fs.existsSync(path.join(UNO,'app/source_wallet.py')));
 fs.mkdirSync(OUT,{recursive:true});tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cp16-source-'));
 rootPool=new Pool({connectionString:dbUrl.toString()});schema='cp16_'+crypto.randomBytes(8).toString('hex');await rootPool.query('CREATE SCHEMA '+schema);dbUrl.searchParams.set('options','-c search_path='+schema+',public');pool=new Pool({connectionString:dbUrl.toString()});
 const p=await port(),gp=await port();base='http://127.0.0.1:'+p;gameBase='http://127.0.0.1:'+gp;
 const sessionSecret=crypto.randomBytes(48).toString('hex');
 unoEnv={...process.env,CI:'true',GAMEOPS_TEST_MODE:'1',GAMEOPS_ROUNDS_ENABLED:'1',GAMEOPS_BRIDGE_ENABLED:'0',GAMEOPS_BRIDGE_KEY_ID:bridgeKey.id,GAMEOPS_BRIDGE_SECRET:bridgeKey.secret,GAMEOPS_ENVIRONMENT:'staging',GAMEOPS_RECEIVER_URL:base+'/api/v2/game-bridge',UNO_SPIN_DB_PATH:path.join(tmp,'game.sqlite3'),UNO_SOUND_STORAGE_DIR:'',PYTHONUNBUFFERED:'1',GAMEOPS_WALLET_ENABLED:'0',GAMEOPS_WALLET_COMMANDS_ENABLED:'1',GAMEOPS_WALLET_KEY_ID:walletKey.id,GAMEOPS_WALLET_SECRET:walletKey.secret,GAMEOPS_WALLET_RECEIVER:base+P.PATH};
 // Seed a real pre-cutover guest using the original source account function, not a fake balance observation.
 const seed=JSON.parse(py("from app import spin,round_outbox\nfrom fastapi import Response\nfrom types import SimpleNamespace\nimport json\nc=spin.connection();a=spin.get_account(SimpleNamespace(cookies={},url=SimpleNamespace(scheme='http'),headers={}),Response(),c);m=round_outbox.meta(c);print(json.dumps({'stream':m['stream_id'],'account':a['id']}));c.close()"));
 walletKey.streamId=seed.stream;unoEnv.GAMEOPS_WALLET_ENABLED='1';
 adminEnv={...process.env,DATABASE_URL:dbUrl.toString(),PORT:String(p),PUBLIC_SITE_URL:base,RAILWAY_PUBLIC_DOMAIN:'',SESSION_SECRET:sessionSecret,ADMIN_USERNAME:'qa_owner',ADMIN_PASSWORD:crypto.randomBytes(32).toString('base64url'),NODE_ENV:'test',GAMEOPS_BRIDGE_KEYS:JSON.stringify([bridgeKey]),GAMEOPS_ADDITIONAL_KEYS:'[]',GAMEOPS_WALLET_KEYS:JSON.stringify([walletKey])};
 await startAdmin();await startUno();
 const own=(await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='qa_owner' RETURNING id,password_hash")).rows[0];
 for(const role of ['owner','support','viewer']){
  const id=role==='owner'?own.id:(await pool.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash,must_change_password,mfa_enabled) VALUES($1,$2,$3,$4,false,true) RETURNING id",['qa_'+role,'QA '+role,role,own.password_hash])).rows[0].id;
  const raw=crypto.randomBytes(32).toString('base64url');await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '2 hours')",[id,sha(raw)]);
  creds.set(role,{raw,cookie:'gameops_session='+raw,csrf:crypto.createHmac('sha256',sessionSecret).update('cp08:csrf:'+raw).digest('base64url')});
 }
 const guest=await fetch(gameBase+'/api/orbit/state');assert.equal(guest.status,200);cookie=guest.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^ul_spin_guest=/);
 accountId=sqlite('SELECT id FROM accounts WHERE token_hash=?',[sha(cookie.split('=')[1])])[0].id;
 let observedPlayer;
 await check('A/B mapping and authoritative opening/welcome/bonus/round ledger',async()=>{
  await matched();
  const initial=(await req(PREFIX+'players'+SCOPE)).data.items;assert.equal(initial.length,2);
  const accountRef=py("from app import spin,round_outbox,source_wallet as W\nimport os\nc=spin.connection();print(W.ref_for(os.environ['QA_ACCOUNT'],round_outbox.meta(c)));c.close()",{QA_ACCOUNT:accountId});
  sourcePlayer=initial.find(x=>x.player_ref===accountRef).id;
  const old=initial.find(x=>x.id!==sourcePlayer);const opening=(await req(PREFIX+'players/'+old.id+SCOPE)).data;
  assert.equal(opening.entries[0].kind,'opening_snapshot');assert.equal(opening.item.balance,'1000');
  const start=await detail();assert.equal(start.entries[0].kind,'welcome');assert.equal(start.item.balance,'1000');
  await gameReq('/api/spin/daily',{});await gameReq('/api/spin/refill',{});await runRound();await fresh();
  const d=await detail();assert.equal(Number(d.item.balance),sourceBalance());assert.equal(d.item.verification,'matched');
  for(const kind of ['welcome','daily','free_refill','orbit_stake','orbit_payout'])assert.ok(d.entries.some(x=>x.kind===kind),kind);
  const obs=await wait(async()=>{const r=await req('/api/admin/data/players'+SCOPE);return r.data.items?.find(x=>x.player_ref===accountRef)},'source round player');
  observedPlayer=obs.id;
  const mapping=await req(PREFIX+'players'+SCOPE+'&observed='+observedPlayer);assert.equal(mapping.data.items.length,1);assert.equal(mapping.data.items[0].id,sourcePlayer);
  assert.equal(d.item.identity_verified,false);assert.equal(d.item.cash_value,false);assert.equal(d.item.authority,'game_server');
  assert.equal(JSON.stringify(d).includes(accountId),false);assert.equal(JSON.stringify(d).includes(cookie.split('=')[1]),false);
  return {existingAccount:'explicit_opening_snapshot',newAccount:'actual_welcome',realBonusAndWagerCapture:true,observedPlayerMapped:true,balanceMatchesSource:true,personalIdentityNotClaimed:true};
 });
 await check('scope, anonymous, CSRF and owner-only review',async()=>{
  assert.equal((await req(PREFIX+'players'+SCOPE,{actor:null})).status,401);
  assert.equal((await req(PREFIX+'players'+SCOPE,{actor:'viewer'})).status,403);
  assert.equal((await req(PREFIX+'players/'+sourcePlayer+'?environment=production')).status,404);
  assert.equal((await req(PREFIX+'players?environment=production')).data.items.length,0);
  const r=await createRequest('credit','20','support');assert.equal(r.status,201);assert.equal(r.data.state,'pending_approval');
  assert.equal((await review(r.data.id,{actor:'support'})).status,403);
  assert.equal((await req(PREFIX+'requests'+SCOPE,{method:'POST',body:r.body,noCsrf:true})).status,403);
  const rejected=await review(r.data.id,{decision:'reject'});assert.equal(rejected.status,200);assert.equal((await result(r.data.id)).state,'rejected_by_admin');
  const replay=await req(PREFIX+'requests'+SCOPE,{method:'POST',body:r.body,actor:'support'});assert.equal(replay.status,200);assert.equal(replay.data.state,'rejected_by_admin');
  const wrong=await req(PREFIX+'requests'+SCOPE,{method:'POST',body:{...r.body,amount:'21'},actor:'support'});assert.equal(wrong.status,409);
  return {anonymous:401,viewer:403,crossEnvironment:404,csrf:403,supportReview:403,approvalDistinctFromCredit:true};
 });
 let appliedCredit;
 await check('C/D approve is pending until source ledger and signed receipt confirm application',async()=>{
  await fresh();await stop(uno);uno=null;const before=sourceBalance();
  const r=await createRequest('credit','75');assert.equal(r.status,201);
  const queued=await review(r.data.id);assert.equal(queued.status,200);assert.equal(queued.data.state,'queued');assert.equal(queued.data.applied,false);
  assert.equal(sourceBalance(),before);assert.equal((await result(r.data.id)).state,'queued');
  const replay=await req(PREFIX+'requests'+SCOPE,{method:'POST',body:r.body});assert.equal(replay.data.state,'queued');
  await startUno();const done=await terminal(r.data.id);assert.equal(done.state,'applied');assert.equal(sourceBalance(),before+75);
  await fresh();const d=await detail();assert.equal(d.item.balance,String(before+75));assert.ok(d.entries.some(e=>e.command_id===done.command_id&&e.kind==='admin_credit'));
  const source=sqlite('SELECT count(*) AS n FROM ledger WHERE id=?',['wc_'+done.command_id]);assert.equal(source[0].n,1);
  const replaySource=JSON.parse(py("from app import spin,source_wallet as W\nimport json,os\nc=spin.connection();p=c.execute('SELECT payload FROM gameops_wallet_commands WHERE id=?',(os.environ['QA_COMMAND'],)).fetchone()[0];print(json.dumps(W.apply_command(c,json.loads(p))));c.close()",{QA_COMMAND:done.command_id}));
  assert.equal(replaySource.status,'applied');assert.equal(sourceBalance(),before+75);appliedCredit=done;
  return {queuedNotApplied:true,sourceApplied:true,delta:75,ledgerRows:1,signedReceipt:true,sourceReplayDidNotCreditTwice:true};
 });
 await check('debit, insufficient balance and concurrent revision protection',async()=>{
  await fresh();let before=sourceBalance();const debit=await createRequest('debit','20');assert.equal((await review(debit.data.id)).status,200);assert.equal((await terminal(debit.data.id)).state,'applied');assert.equal(sourceBalance(),before-20);await fresh();
  const insufficient=await createRequest('debit','1000000');assert.equal((await review(insufficient.data.id)).status,409);
  assert.equal((await result(insufficient.data.id)).state,'pending_approval');await review(insufficient.data.id,{decision:'reject'});
  await fresh();await stop(uno);uno=null;before=sourceBalance();
  const a=await createRequest('debit','15'),b=await createRequest('debit','15');
  const concurrent=await Promise.all([review(a.data.id),review(b.data.id)]);assert.ok(concurrent.every(x=>x.status===200));
  const twice=await review(a.data.id);assert.equal(twice.status,409);
  await startUno();const results=await Promise.all([terminal(a.data.id),terminal(b.data.id)]);
  assert.equal(results.filter(x=>x.state==='applied').length,1);assert.equal(results.filter(x=>x.result?.reason==='stale_revision').length,1);assert.equal(sourceBalance(),before-15);
  await fresh();return {validDebit:true,insufficientApprovalBlocked:true,concurrentCommandsOneApplied:true,other:'stale_revision',duplicateReview:409};
 });
 await check('active game round rejects a balance command without mutating gameplay',async()=>{
  await gameReq('/api/orbit/pick',{stake:25,request_id:'cp16_'+crypto.randomBytes(12).toString('hex')});await fresh();const before=sourceBalance();
  const r=await createRequest('credit','30');assert.equal((await review(r.data.id)).status,200);const out=await terminal(r.data.id);assert.equal(out.state,'rejected_by_source');assert.equal(out.result.reason,'active_round');assert.equal(sourceBalance(),before);
  for(let i=0;i<2;i++)await gameReq('/api/orbit/pick',{stake:25,request_id:'cp16_'+crypto.randomBytes(12).toString('hex')});
  await fresh();return {sourceRejected:'active_round',noInjectedOutcome:true,originalRoundStillCompletes:true};
 });
 await check('administrative audit failures roll back request and approval',async()=>{
  await fresh();const key=crypto.randomUUID();await failAudit('source_wallet.request.created');
  const failed=await createRequest('credit','10','owner',{idempotency_key:key});assert.equal(failed.status,500);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_source_wallet_requests WHERE idempotency_key=$1',[key])).rows[0].n,0);
  await failAudit(null);const r=await createRequest('credit','10','owner',{idempotency_key:key});assert.equal(r.status,201);
  await failAudit('source_wallet.request.approved');const failedReview=await review(r.data.id);assert.equal(failedReview.status,500);
  assert.equal((await result(r.data.id)).state,'pending_approval');assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_source_wallet_commands WHERE request_id=$1',[r.data.id])).rows[0].n,0);
  await failAudit(null);await review(r.data.id,{decision:'reject'});
  return {requestRollback:true,approvalRollback:true,noOrphanCommand:true};
 });
 await check('source applied receipt audit failure stays pending and retries without duplicate credit',async()=>{
  await fresh();const before=sourceBalance();const r=await createRequest('credit','17');await failAudit('source_wallet.command.applied');
  assert.equal((await review(r.data.id)).status,200);
  await wait(()=>sourceBalance()===before+17,'source apply despite dropped receipt');
  await wait(async()=>{const d=await result(r.data.id);return d.state==='awaiting_source_confirmation'},'not reported as success');
  assert.equal((await pool.query('SELECT result_hash FROM gameops_source_wallet_commands WHERE request_id=$1',[r.data.id])).rows[0].result_hash,null);
  await failAudit(null);const done=await terminal(r.data.id);assert.equal(done.state,'applied');assert.equal(sourceBalance(),before+17);
  assert.equal(sqlite('SELECT count(*) AS n FROM ledger WHERE id=?',['wc_'+done.command_id])[0].n,1);await fresh();
  return {noFakeSuccess:true,retryRecovered:true,onePhysicalCredit:true};
 });
 await check('receiver outage and source restart preserve account ledger and pending observations',async()=>{
  await fresh();const before=sqlite('SELECT count(*) AS n FROM gameops_wallet_events')[0].n;
  await stop(admin);admin=null;await runRound();
  await wait(async()=>{const s=await sourceStatus();return s.pending_events>0},'pending ledger during outage');
  const actual=sourceBalance();await stop(uno);uno=null;await startUno();assert.equal(sourceBalance(),actual);
  await startAdmin();await fresh();const s=await sourceStatus();assert.ok(s.source_events>before);assert.equal(s.pending_events,0);assert.equal(s.pending_results,0);
  return {sourceRestartPreservedBalance:true,receiverRecovery:true,exactBalance:true,pending:0};
 });
 await check('forged, replayed and wrong-stream messages cannot change the source mirror',async()=>{
  await fresh();await stop(uno);uno=null;
  const payload=JSON.parse(py("from app import spin,round_outbox,source_wallet as W\nimport json\nc=spin.connection();r=c.execute('SELECT * FROM gameops_wallet_events ORDER BY sequence LIMIT 1').fetchone();print(json.dumps(W.envelope(c,'wallet.events',events=[W.event_for(r,round_outbox.meta(c))])));c.close()"));
  const before=await detail();const nonce=crypto.randomBytes(16).toString('hex');
  const repeated=await signed(payload,{nonce});assert.equal(repeated.status,200);assert.equal(repeated.data.inserted,0);
  assert.equal((await signed(payload,{nonce})).status,409);assert.equal((await signed(payload,{forged:true})).status,401);
  assert.equal((await signed({...payload,stream_id:crypto.randomUUID()})).status,403);
  assert.equal((await signed({...payload,events:[{...payload.events[0],delta:'999'}]})).status,409);
  const after=await detail();assert.equal(after.item.balance,before.item.balance);assert.equal(after.item.revision,before.item.revision);
  await startUno();await fresh();return {signedDuplicateNoDoubleCount:true,nonceReplay:409,forgery:401,wrongStream:403,conflictingLedger:409};
 });
 await check('real HTTP browser: source balance, request, owner decision and linked player data',async()=>{
  const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'gameops_session',value:creds.get('owner').raw,url:base,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/data'+SCOPE+'&tab=players');await page.getByRole('heading',{name:/Observed Players/}).waitFor();
   await page.locator('tbody a').first().click();await page.getByRole('heading',{name:'Observed Player Detail'}).waitFor();
   await page.getByRole('link',{name:'Open source wallet and balance history'}).click();await page.getByRole('heading',{name:'Source Wallets / staging'}).waitFor();
   assert.equal(await page.locator('tbody tr').count(),1);await page.locator('tbody a').first().click();
   await page.getByRole('heading',{name:'Source Player & Wallet Detail'}).waitFor();assert.match(await page.locator('#content').innerText(),/game_server|game owns|game is/i);
   await page.locator('#wallet-request select[name=action]').selectOption('credit');await page.locator('#wallet-request input[name=amount]').fill('9');await page.locator('#wallet-request textarea[name=reason]').fill('QA browser virtual source adjustment');
   await page.locator('#wallet-request button[type=submit]').click();await page.getByRole('heading',{name:'Source balance request'}).waitFor();
   assert.match(await page.locator('#content').innerText(),/pending_approval/);
   await page.locator('#wallet-review textarea[name=note]').fill('QA owner reviewed browser request');page.once('dialog',d=>d.accept());await page.locator('#wallet-review button[type=submit]').click();
   await page.getByRole('button',{name:'Refresh request status'}).waitFor();
   const id=new URL(page.url()).searchParams.get('id');await terminal(id);await page.locator('#refresh').click();await page.getByText('applied',{exact:true}).first().waitFor();
   await page.screenshot({path:path.join(OUT,'request-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(OUT,'request-mobile.png'),fullPage:true});
   await page.goto(base+'/data'+SCOPE+'&tab=wallet&id='+sourcePlayer);await page.getByRole('heading',{name:'Source Player & Wallet Detail'}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(OUT,'source-wallet-mobile.png'),fullPage:true});
   assert.deepEqual(errors,[]);return {apiMocked:false,sourcePlayerLinked:true,requestAndReview:true,actualSourceApplied:true,desktop:true,mobile390:true,errors:0};
  }finally{await browser.close()}
 });
 await check('final runtime restart preserves balances, all application receipts and production separation',async()=>{
  await fresh();const before=sourceBalance();await stop(admin);admin=null;await stop(uno);uno=null;await startAdmin();await startUno();await fresh();
  assert.equal(sourceBalance(),before);const d=await detail();assert.equal(d.item.balance,String(before));
  assert.equal((await req(PREFIX+'players?environment=production')).data.items.length,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_virtual_wallet_operations')).rows[0].n,0);
  const s=await sourceStatus();assert.equal(s.pending_results,0);assert.equal(s.pending_events,0);assert.equal(s.reconciliation,'matched');
  const expected=sqlite('SELECT count(*) AS n FROM gameops_wallet_events')[0].n;
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_source_wallet_entries')).rows[0].n,expected);
  return {sourceAndReceiverRestart:true,ledgerCount:expected,sourceBalanceMatches:true,pending:0,legacyWalletMutations:0,productionWallets:0};
 });
 report.result='PASS';report.finishedAt=new Date().toISOString();
}
main().catch(e=>{report.result='FAIL';report.failures.push({message:e.message,stack:e.stack});console.error(e);process.exitCode=1}).finally(async()=>{
 await stop(uno);await stop(admin);if(pool)await pool.end();if(rootPool){if(schema)await rootPool.query('DROP SCHEMA '+schema+' CASCADE');await rootPool.end();}if(tmp)fs.rmSync(tmp,{recursive:true,force:true});
 fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(OUT,'runtime.log'),adminLog+'\nUNO\n'+unoLog);console.log(JSON.stringify(report));
});
