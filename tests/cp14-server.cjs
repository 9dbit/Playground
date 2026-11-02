'use strict';
// Full server, real middleware and disposable localhost PostgreSQL. No production contact.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict'),{Pool}=require('pg'),sharp=require('sharp');
const ROOT=path.join(__dirname,'..'),OUT=path.join(ROOT,'test-results','cp14');
const report={release:'0.14.0',mode:'real-server-isolated-postgresql',productionContacted:false,checks:[],failures:[],startedAt:new Date().toISOString()};
const creds=new Map(),gid='aaaaaaaa-1111-4111-8111-111111111111',other='bbbbbbbb-2222-4222-8222-222222222222',p1='abcdefab-1111-4111-8111-111111111111',p2='bcdefabc-2222-4222-8222-222222222222';
let child,pool,rootPool,schema,baseUrl,log='',env;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
async function check(id,title,fn){try{const evidence=await fn();report.checks.push({id,title,status:'PASS',evidence});console.log('CP14_PASS',id,title)}catch(e){report.failures.push({id,title,error:e.message});console.error('CP14_FAIL',id,e.stack)}}
async function req(endpoint,method='GET',body,actor='qa_owner',extra={}){
 const a=actor&&creds.get(actor),headers={Origin:baseUrl,...(a?{Cookie:a.cookie,'X-CSRF-Token':a.csrf}:{}),...extra};
 if(body!==undefined)headers['Content-Type']='application/json';
 const r=await fetch(baseUrl+endpoint,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(15000)});
 const bytes=Buffer.from(await r.arrayBuffer()),text=bytes.toString('utf8');let data;try{data=JSON.parse(text)}catch{data=null}
 return {status:r.status,data,text,bytes,headers:r.headers};
}
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL')}}
async function start(){child=spawn(process.execPath,['server.js'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Server exited: '+log.slice(-1000));try{if((await req('/health','GET',undefined,null)).status===200)return}catch{}await delay(150)}throw Error('Startup timeout')}
async function fault(action,on=true){await pool.query(on?'INSERT INTO cp14_fault_actions(action) VALUES($1) ON CONFLICT DO NOTHING':'DELETE FROM cp14_fault_actions WHERE action=$1',[action])}
async function snapshot(sql,args=[]){return (await pool.query(sql,args)).rows}
async function rollbackCase(id,action,endpoint,method,body,sql,args=[],actor='qa_owner'){
 await check('F04-'+id,'Audit failure rolls back '+action,async()=>{
  const before=await snapshot(sql,args);await fault(action);let result;
  try{result=await req(endpoint,method,body,actor)}finally{await fault(action,false)}
  assert.equal(result.status,500,JSON.stringify(result.data));assert.deepEqual(await snapshot(sql,args),before);
  return {http:500,persistedChange:false};
 });
}
const prefix='/api/admin';
async function main(){
 const url=new URL(process.env.TEST_DATABASE_URL||'http://invalid');
 assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/gameops_ci');assert.equal(process.env.CI,'true');
 fs.mkdirSync(OUT,{recursive:true});
 rootPool=new Pool({connectionString:url.toString()});schema='cp14_'+crypto.randomBytes(8).toString('hex');await rootPool.query('CREATE SCHEMA '+schema);url.searchParams.set('options','-c search_path='+schema+',public');pool=new Pool({connectionString:url.toString()});
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));baseUrl='http://127.0.0.1:'+port;
 const secret=crypto.randomBytes(48).toString('hex');env={...process.env,DATABASE_URL:url.toString(),SESSION_SECRET:secret,ADMIN_USERNAME:'qa_owner',ADMIN_PASSWORD:crypto.randomBytes(32).toString('base64url'),PORT:String(port),NODE_ENV:'test',PUBLIC_SITE_URL:baseUrl,RAILWAY_PUBLIC_DOMAIN:'',GAMEOPS_BRIDGE_KEYS:'[]',DEV_ACCESS_ENABLED:'false'};
 await start();assert.equal((await req('/health','GET',undefined,null)).data.version,require('../package.json').version);
 const owner=(await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='qa_owner' RETURNING id,password_hash")).rows[0];
 for(const role of ['owner','operator','support','viewer']){
  const username='qa_'+role,id=role==='owner'?owner.id:(await pool.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash,must_change_password,mfa_enabled) VALUES($1,$1,$2,$3,false,true) RETURNING id",[username,role,owner.password_hash])).rows[0].id;
  const raw=crypto.randomBytes(32).toString('base64url');await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '2 hours')",[id,hash(raw)]);
  creds.set(username,{id,cookie:'gameops_session='+raw,csrf:crypto.createHmac('sha256',secret).update('cp08:csrf:'+raw).digest('base64url')});
 }
 await pool.query('INSERT INTO gameops_games(id,name,slug,code,platform) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',[gid,'CP14 Game','cp14-main','QA','Web',other,'Other','cp14-other','Q2','Web']);
 await pool.query('INSERT INTO gameops_players(id,game_id,player_ref) VALUES($1,$2,$3),($4,$2,$5)',[p1,gid,'cp14-one',p2,'cp14-two']);
 for(let i=0;i<8;i++)await pool.query('INSERT INTO gameops_events(event_id,game_id,round_id,player_ref,stake,payout,occurred_at) VALUES($1,$2,$3,$4,100,$5,now())',['cp14-event-'+i,gid,'cp14-round-'+i,i%2?'cp14-two':'cp14-one',i%2?150:0]);
 await check('AUTH','Anonymous, CSRF, role boundaries remain enforced',async()=>{
  assert.equal((await req(prefix+'/summary','GET',undefined,null)).status,401);
  assert.equal((await req(prefix+'/settings/general','PUT',{value:{site_title:'bad'},expected_version:0},'qa_owner',{'X-CSRF-Token':''})).status,403);
  assert.equal((await req(prefix+'/settings/general','PUT',{value:{site_title:'bad'},expected_version:0},'qa_support')).status,403);
  assert.equal((await req(prefix+'/virtual-wallets/'+p1+'/adjust','POST',{action:'credit',amount:1,note:'role check',idempotency_key:crypto.randomUUID()},'qa_viewer')).status,403);
  return {anonymous:401,csrf:403,roles:403};
 });
 await check('F01','Actual server honors canonical game log filters and pagination',async()=>{
  const r=await req(prefix+'/deep/games/'+gid+'/rounds?result=win&limit=1&page=2');assert.equal(r.status,200);assert.equal(r.data.total,4);assert.equal(r.data.items.length,1);assert.equal(r.data.page,2);assert.equal(r.data.items[0].result,'win');
  assert.equal((await req(prefix+'/deep/games/'+gid+'/rounds?result=wrong')).status,400);
  const files=['server.js','engine/deep-routes.js','engine/security.js','engine/admin-operations.js','engine/virtual-wallet.js','engine/game-bridge.js','engine/public-content.js','engine/parity.js'];const seen=new Set();
  for(const file of files)for(const m of fs.readFileSync(path.join(ROOT,file),'utf8').matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'\s*,/g)){const key=m[1]+' '+m[2].replace(/:[^/]+/g,':param');assert.ok(!seen.has(key),'Duplicate route '+key);seen.add(key)}
  return {rows:1,total:4,page:2,duplicateLiteralRoutes:0};
 });
 const validSettings={
  general:{site_title:'QA General',currency:'Demo Coin',currency_symbol:'D',timezone:'Asia/Jakarta',base_color:'#123456',secondary_color:'#abcdef',per_page:20,currency_format:'symbol',register_bonus:0,demo_balance:0,transfer_fixed:0,transfer_percent:1.5,gameplay_bonus_count:0,gameplay_bonus:0},
  logo:{logo_url:'/assets/logo.png',favicon_url:'https://example.com/favicon.png'},configuration:{name:'QA',read_only:false,bridge_enabled:false},notification:{in_app_enabled:true,email_enabled:false,sender:'QA'},seo:{meta_title:'QA',meta_description:'test',keywords:'qa'},kyc:{kyc_enabled:false,retention_days:30},social:{google:false,apple:false},language:{default_locale:'en',supported:'en,id'},extensions:{registry_url:'',enabled:false},cron:{enabled:false,interval_minutes:10,description:'QA cleanup'},maintenance:{enabled:false,message:'QA'},gdpr:{notice:'QA',required:false},css:{draft:''},sitemap:{enabled:true,endpoint:'/sitemap.xml'},robots:{rules:'User-agent: *\nDisallow: /engine\n'}
 };
 await check('F02','Typed schemas validate all settings fields and content-managed modules',async()=>{
  for(const [key,value] of Object.entries(validSettings)){
   const good=await req(prefix+'/settings/'+key,'PUT',{value,expected_version:0});assert.equal(good.status,200,key+JSON.stringify(good.data));
   const bad=await req(prefix+'/settings/'+key,'PUT',{value:{...value,unknown:'no'},expected_version:1});assert.equal(bad.status,400,key);
  }
  const bads=[{per_page:-10},{register_bonus:-500},{transfer_percent:101},{timezone:'Not/AZone'},{base_color:'orange'},{demo_balance:'100'},{site_title:''}];
  for(const bad of bads)assert.equal((await req(prefix+'/settings/general','PUT',{value:{...validSettings.general,...bad},expected_version:1})).status,400);
  for(const value of [null,[],{},'bad'])assert.equal((await req(prefix+'/settings/general','PUT',{value,expected_version:1})).status,400);
  assert.equal((await req(prefix+'/settings/logo','PUT',{value:{logo_url:'javascript:alert(1)'},expected_version:1})).status,400);
  assert.equal((await req(prefix+'/settings/cron','PUT',{value:{enabled:'true'},expected_version:1})).status,400);
  for(const key of ['pages','policies','frontend','templates','unknown'])assert.equal((await req(prefix+'/settings/'+key,'PUT',{value:{enabled:true},expected_version:0})).status,400);
  const stored=(await pool.query("SELECT value,version FROM gameops_settings WHERE key='general'")).rows[0];assert.equal(stored.version,1);assert.deepEqual(stored.value,validSettings.general);
  return {typedSettings:15,contentModules:4,invalidWritesPersisted:0};
 });
 await check('F03','Settings create/update CAS protects concurrent writers and stale tabs',async()=>{
  assert.equal((await req(prefix+'/settings/general','PUT',{value:validSettings.general})).status,428);
  const responses=await Promise.all(['First writer','Second writer'].map(name=>req(prefix+'/settings/general','PUT',{value:{...validSettings.general,site_title:name},expected_version:1})));
  assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
  assert.equal((await req(prefix+'/settings/general','PUT',{value:{site_title:'Stale'},expected_version:1})).status,409);
  const after=(await pool.query("SELECT value,version FROM gameops_settings WHERE key='general'")).rows[0];assert.equal(after.version,2);assert.notEqual(after.value.site_title,'Stale');
  await pool.query("DELETE FROM gameops_settings WHERE key='logo'");
  const inserts=await Promise.all([1,2].map(()=>req(prefix+'/settings/logo','PUT',{value:validSettings.logo,expected_version:0})));
  assert.deepEqual(inserts.map(x=>x.status).sort(),[200,409]);return {concurrentUpdate:[200,409],concurrentCreate:[200,409],missingVersion:428};
 });
 await pool.query('CREATE TABLE cp14_fault_actions(action text PRIMARY KEY)');
 await pool.query("CREATE FUNCTION cp14_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM cp14_fault_actions WHERE action=NEW.action) THEN RAISE EXCEPTION 'CP14_INJECTED_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$");
 await pool.query('CREATE TRIGGER cp14_audit_fault BEFORE INSERT ON gameops_audit FOR EACH ROW EXECUTE FUNCTION cp14_audit_fault()');
 const config={name:'CP14 Game',code:'QA',platform:'Web',winning_chance:65,win_amount:40,demo_chance:50,invest_enabled:false,min_invest:1,max_invest:1000,trending:false,featured:false,instructions:'Synthetic test only',version:1};
 const configured=await req(prefix+'/deep/games/'+gid,'PUT',config);assert.equal(configured.status,200,JSON.stringify(configured.data));config.version=2;
 const tk=await req(prefix+'/tickets','POST',{subject:'CP14 ticket',requester_ref:'qa',priority:'Low'},'qa_support');assert.equal(tk.status,201);const tid=tk.data.item.id;
 const sub=await req(prefix+'/deep/subscribers','POST',{contact:'fixture@example.test'});assert.equal(sub.status,201);const sid=sub.data.item.id;
 const cbody={slug:'repair-content',title:'CP14 Content',body:'Original body',status:'published'};
 const cr=await req(prefix+'/deep/content/page','POST',cbody);assert.equal(cr.status,201);const cid=cr.data.item.id;
 const rid=(await pool.query("INSERT INTO gameops_requests(player_ref,amount) VALUES('cp14-one',10) RETURNING id")).rows[0].id;
 const imageBytes=await sharp({create:{width:48,height:32,channels:3,background:'#335588'}}).jpeg().withMetadata().toBuffer();
 const imageData='data:image/jpeg;base64,'+imageBytes.toString('base64');
 assert.equal((await req(prefix+'/deep/games/'+gid+'/image','POST',{data:imageData})).status,200);
 await rollbackCase('game','game.config.updated',prefix+'/deep/games/'+gid,'PUT',{...config,name:'Must Roll Back'},'SELECT name,updated_at FROM gameops_games WHERE id=$1',[gid]);
 await rollbackCase('create-game','game.created',prefix+'/games','POST',{name:'No record',slug:'must-rollback',code:'RB',platform:'Web'},"SELECT id FROM gameops_games WHERE slug='must-rollback'");
 await rollbackCase('status','game.status_changed',prefix+'/games/'+gid,'PATCH',{status:'Active'},'SELECT status,updated_at FROM gameops_games WHERE id=$1',[gid]);
 const ps={first_name:'Should',last_name:'Rollback',city:'',state:'',zip:'',country:'',admin_note:'test',local_status:'review',version:1};
 await rollbackCase('player','player.metadata.updated',prefix+'/deep/players/'+p1,'PUT',ps,'SELECT * FROM gameops_player_profiles WHERE player_id=$1',[p1]);
 const changedImage='data:image/png;base64,'+(await sharp({create:{width:72,height:48,channels:4,background:'#abcdef'}}).png().toBuffer()).toString('base64');
 await rollbackCase('image','game.image.updated',prefix+'/deep/games/'+gid+'/image','POST',{data:changedImage},"SELECT md5(image_bytes) AS digest,image_mime,updated_at FROM gameops_game_profiles WHERE game_id=$1",[gid]);
 await rollbackCase('settings','settings.saved',prefix+'/settings/general','PUT',{value:{site_title:'Must Roll Back'},expected_version:2},"SELECT * FROM gameops_settings WHERE key='general'");
 await rollbackCase('profile','admin.profile.updated',prefix+'/ops/profile','PUT',{displayName:'Must Roll Back'},'SELECT display_name FROM gameops_admin_accounts WHERE id=$1',[owner.id]);
 await rollbackCase('ticket-create','ticket.created',prefix+'/tickets','POST',{subject:'Rollback ticket',requester_ref:'qa'},"SELECT * FROM gameops_tickets WHERE subject='Rollback ticket'");
 await rollbackCase('ticket-status','ticket.status_changed',prefix+'/tickets/'+tid,'PATCH',{status:'Closed'},'SELECT * FROM gameops_tickets WHERE id=$1',[tid]);
 await rollbackCase('ticket-reply','ticket.reply.recorded',prefix+'/deep/tickets/'+tid+'/replies','POST',{body:'Rollback reply'},'SELECT * FROM gameops_ticket_messages WHERE ticket_id=$1',[tid],'qa_support');
 await rollbackCase('review','request.reviewed',prefix+'/requests/'+rid,'PATCH',{status:'approved',note:'Rollback approval'},'SELECT * FROM gameops_requests WHERE id=$1',[rid]);
 await rollbackCase('notification','notification.recorded',prefix+'/deep/notifications','POST',{recipient_ref:'qa',title:'Rollback notification',body:'No delivery'},'SELECT * FROM gameops_notifications');
 await rollbackCase('subscriber-new','subscriber.created',prefix+'/deep/subscribers','POST',{contact:'rollback@example.test'},"SELECT * FROM gameops_subscribers WHERE contact='rollback@example.test'");
 await rollbackCase('subscriber-state','subscriber.status.updated',prefix+'/deep/subscribers/'+sid,'PATCH',{status:'unsubscribed'},'SELECT * FROM gameops_subscribers WHERE id=$1',[sid]);
 await rollbackCase('content-create','content.created',prefix+'/deep/content/page','POST',{...cbody,slug:'rollback-content'},"SELECT * FROM gameops_content WHERE slug='rollback-content'");
 await rollbackCase('content-update','content.updated',prefix+'/deep/content/page/'+cid,'PUT',{...cbody,body:'Should Roll Back',version:1},'SELECT * FROM gameops_content WHERE id=$1',[cid]);
 await check('F05','Banned/review SQL filtering happens before stable pagination',async()=>{
  await pool.query("UPDATE gameops_players SET last_seen=now()-interval '90 days' WHERE id=$1",[p2]);
  await pool.query("INSERT INTO gameops_player_profiles(player_id,local_status) VALUES($1,'blocked_locally') ON CONFLICT(player_id) DO UPDATE SET local_status='blocked_locally'",[p2]);
  await pool.query("INSERT INTO gameops_players(game_id,player_ref,last_seen) SELECT $1,'cp14-recent-'||n,now() FROM generate_series(1,205)n",[gid]);
  const banned=await req(prefix+'/deep/players?state=banned&limit=1&page=1');assert.equal(banned.status,200);assert.equal(banned.data.total,1);assert.equal(banned.data.items[0].id,p2);
  const first=await req(prefix+'/deep/players?state=active&limit=100&page=1'),second=await req(prefix+'/deep/players?state=active&limit=100&page=2');
  assert.equal(first.data.total,206);assert.equal(first.data.items.length,100);assert.equal(second.data.items.length,100);assert.equal(new Set([...first.data.items,...second.data.items].map(x=>x.id)).size,200);
  assert.equal((await req(prefix+'/deep/players?state=unknown')).status,400);assert.equal((await req(prefix+'/deep/players?limit=1.5')).status,400);
  assert.equal((await req(prefix+'/players?state=banned')).data.total,1,'Legacy API must share canonical SQL filter');
  return {olderBannedVisible:true,totalActive:206,pagingDuplicateIds:0};
 });
 await check('F06','Reply author uses authenticated Support identity and preserves history',async()=>{
  const historical=(await pool.query("INSERT INTO gameops_ticket_messages(ticket_id,author,body) VALUES($1,'admin','Historical') RETURNING id",[tid])).rows[0].id;
  const sent=await req(prefix+'/deep/tickets/'+tid+'/replies','POST',{body:'Authored by Support',author:'forged_owner'},'qa_support');assert.equal(sent.status,201);assert.equal(sent.data.item.author,'qa_support');
  const messages=(await req(prefix+'/deep/tickets/'+tid)).data.messages;assert.equal(messages.find(x=>x.id===String(historical)).author,'admin');assert.equal(messages.at(-1).author,'qa_support');
  return {author:'qa_support',historicalAuthorUnchanged:true};
 });
 await check('F07','Canonical content namespaces preserve page/policy collisions safely',async()=>{
  const b={slug:'shared-url',body:'page body',title:'Distinct Page',status:'published'};
  const page=await req(prefix+'/deep/content/page','POST',b),policy=await req(prefix+'/deep/content/policy','POST',{...b,title:'Distinct Policy',body:'policy body'});
  assert.equal(page.status,201);assert.equal(policy.status,201);assert.equal(page.data.item.public_path,'/info/page/shared-url');assert.equal(policy.data.item.public_path,'/info/policy/shared-url');
  assert.match((await req('/info/page/shared-url','GET',undefined,null)).text,/Distinct Page/);assert.match((await req('/info/policy/shared-url','GET',undefined,null)).text,/Distinct Policy/);
  const old=await req('/info/shared-url','GET',undefined,null);assert.equal(old.status,409);assert.equal(old.data.canonicalPaths.length,2);
  const unique=await req('/info/repair-content','GET',undefined,null);assert.equal(unique.status,308);assert.equal(unique.headers.get('location'),'/info/page/repair-content');
  const draft=await req(prefix+'/deep/content/page','POST',{slug:'secret-draft',title:'Not public',body:'hidden',status:'draft'});assert.equal(draft.status,201);assert.equal((await req('/info/page/secret-draft','GET',undefined,null)).status,404);
  const xml=(await req('/sitemap.xml','GET',undefined,null)).text;const urls=[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(x=>x[1]);assert.equal(new Set(urls).size,urls.length);assert.ok(urls.includes(baseUrl+'/info/page/shared-url'));assert.ok(urls.includes(baseUrl+'/info/policy/shared-url'));assert.ok(!xml.includes('secret-draft'));
  await stop();await start();
  assert.equal((await req('/info/page/shared-url','GET',undefined,null)).status,200);assert.equal((await req('/info/policy/shared-url','GET',undefined,null)).status,200);
  assert.equal((await pool.query("SELECT count(*)::int AS total FROM gameops_content WHERE slug='shared-url'")).rows[0].total,2);
  return {canonicalPaths:2,legacyAmbiguity:409,uniqueLegacyRedirect:308,recordsDeleted:0,restart:true};
 });
 await check('F08','Artwork is decoded, bounded and re-encoded instead of trusting signatures',async()=>{
  for(const data of ['data:image/jpeg;base64,/9g=','data:image/png;base64,iVBORw0KGgo=','data:image/svg+xml;base64,PHN2Zz4='])assert.equal((await req(prefix+'/deep/games/'+gid+'/image','POST',{data})).status,400);
  const oversized=await sharp({create:{width:5000,height:1,channels:3,background:'#fff'}}).png().toBuffer();assert.equal((await req(prefix+'/deep/games/'+gid+'/image','POST',{data:'data:image/png;base64,'+oversized.toString('base64')})).status,400);
  const mismatch=await req(prefix+'/deep/games/'+gid+'/image','POST',{data:'data:image/png;base64,'+imageBytes.toString('base64')});assert.equal(mismatch.status,400);
  const ok=await req(prefix+'/deep/games/'+gid+'/image','POST',{data:imageData});assert.equal(ok.status,200);assert.equal(ok.data.mime,'image/webp');
  const stored=await req(prefix+'/deep/games/'+gid+'/image');assert.equal(stored.headers.get('content-type'),'image/webp');const meta=await sharp(stored.bytes).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,48);assert.equal(meta.exif,undefined);assert.ok(stored.bytes.length<500000);
  return {truncated:400,mismatch:400,oversizedDimensions:400,storedMime:'image/webp',metadataRemoved:true};
 });
 if(process.env.CP14_BROWSER==='true')await check('BROWSER','Actual server: stale settings UI, user pages, ticket author, canonical links and mobile',async()=>{
  const {chromium}=require('playwright'),browser=await chromium.launch({headless:true,args:['--no-sandbox']}),errors=[];
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}});
   await context.addCookies([{name:'gameops_session',value:creds.get('qa_owner').cookie.split('=')[1],url:baseUrl,httpOnly:true,sameSite:'Strict'}]);
   const a=await context.newPage(),b=await context.newPage();a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
   for(const p of [a,b]){await p.goto(baseUrl+'/engine#/setting/general');await p.locator('#setting-save[data-version="2"]').waitFor();}
   await a.locator('input[name=site_title]').fill('Fresh Browser Value');await a.locator('#setting-save button.btn').last().click();await a.locator('#setting-save[data-version="3"]').waitFor();
   await b.locator('input[name=site_title]').fill('Unsaved Browser Value');await b.locator('#setting-save button.btn').last().click();await b.locator('.settings-conflict').waitFor();
   assert.equal(await b.locator('input[name=site_title]').inputValue(),'Unsaved Browser Value');
   assert.equal((await pool.query("SELECT value FROM gameops_settings WHERE key='general'")).rows[0].value.site_title,'Fresh Browser Value');
   await b.screenshot({path:path.join(OUT,'settings-conflict-desktop.png'),fullPage:true});
   await b.getByRole('button',{name:'Reload latest (discard these edits)'}).click();await b.locator('#setting-save[data-version="3"]').waitFor();
   assert.equal(await b.locator('input[name=site_title]').inputValue(),'Fresh Browser Value');
   await b.locator('input[name=site_title]').fill('New after reload');await b.locator('#setting-save button.btn').last().click();await b.locator('#setting-save[data-version="4"]').waitFor();
   await a.goto(baseUrl+'/engine#/players/banned');
   await a.locator('.table tbody').getByText('cp14-two',{exact:true}).waitFor();assert.equal(await a.locator('.table tbody tr').count(),1);
   await a.goto(baseUrl+'/engine#/players/active/1');await a.locator('.paging-controls').waitFor();assert.equal(await a.locator('.table tbody tr').count(),25);
   await a.locator('.paging-controls [data-go="players/active/2"]').click();await a.locator('.paging-controls').getByText('Page 2 / 9',{exact:false}).waitFor();
   await a.goto(baseUrl+'/engine#/ticket/'+tid);await a.getByRole('heading',{name:'Conversation',exact:true}).waitFor();await a.getByText('qa_support',{exact:true}).first().waitFor();
   await a.goto(baseUrl+'/engine#/content/page');await a.locator('a[href="/info/page/shared-url"]').waitFor();
   await a.goto(baseUrl+'/engine#/games');await a.locator('[data-go="game-rounds/'+gid+'"]').first().click();await a.locator('#game-log-filter').waitFor();await a.locator('[data-go$="/win/1"]').first().click();await a.locator('.paging-controls').getByText('4 observed records',{exact:false}).waitFor();assert.equal(await a.locator('.table tbody tr').count(),4);
   await a.setViewportSize({width:390,height:844});assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await a.screenshot({path:path.join(OUT,'game-log-mobile.png'),fullPage:true});
   assert.deepEqual(errors,[]);return {realHttp:true,staleWriteKeptUnsaved:true,pagination:true,canonicalLinks:true,author:true,mobileWidth:390,errorCount:0};
  }finally{await browser.close()}
 });
 await check('WALLET','Virtual ledger atomicity and idempotency remain intact',async()=>{
  const input={action:'credit',amount:100,note:'CP14 synthetic credit',idempotency_key:crypto.randomUUID()};const ep=prefix+'/virtual-wallets/'+p1+'/adjust';
  assert.equal((await req(ep,'POST',input)).status,200);assert.equal((await req(ep,'POST',input)).data.replay,true);
  await fault('virtual_wallet.credit');try{assert.equal((await req(ep,'POST',{...input,idempotency_key:crypto.randomUUID()})).status,500)}finally{await fault('virtual_wallet.credit',false)}
  assert.equal((await req(prefix+'/virtual-wallets/'+p1)).data.balance,'100');assert.equal((await req(ep,'POST',{...input,action:'debit',amount:101,idempotency_key:crypto.randomUUID()})).status,409);
  return {balance:'100',failedAuditRolledBack:true,noDoubleCredit:true};
 });
}
async function finish(){await stop();if(pool)await pool.end().catch(()=>{});if(rootPool&&schema)await rootPool.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(e=>report.failures.push({id:'CLEANUP',error:e.message}));if(rootPool)await rootPool.end().catch(()=>{});report.finishedAt=new Date().toISOString();report.summary={passed:report.checks.length,failed:report.failures.length,result:report.failures.length?'FAIL':'PASS'};fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'cp14-full-server.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(OUT,'fixture-server.log'),log);console.log('CP14_SUMMARY',JSON.stringify(report.summary));if(report.failures.length)process.exitCode=1}
main().catch(e=>{console.error(e);report.failures.push({id:'SETUP',error:e.message})}).finally(finish);
