'use strict';
// Optional cross-repository UAT: actual FastAPI, SQLite, signed Playground API,
// Chromium game renderer, process restart and central immutable ledger.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
module.exports=async({pool,check,player,A,topup,paid,fund,password,ok,base,gameSecret})=>{
 if(!process.env.UNO_NATIVE_PATH)return;
 await check('NATIVE_UNO','UNO native browser settles exactly once in Playground across a game-server restart',async()=>{
  const p=await player(A,'nativeUno');await topup(A.id,10000);await paid(A.id,'nativeUno',1000);
  const gid=(await pool.query("SELECT id FROM gameops_games WHERE slug='uno-luck'")).rows[0].id;
  const launch=await ok('/api/player/launch','POST',{game_id:gid},'nativeUno');
  const net=require('node:net').createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const port=net.address().port;await new Promise(r=>net.close(r));
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agency-native-uno-'));
  const env={...process.env,AGENCY_WALLET_MODE:'sandbox',AGENCY_WALLET_ORIGIN:base,AGENCY_WALLET_KEY_ID:'qa-uno',AGENCY_WALLET_SECRET:gameSecret,AGENCY_WALLET_LOCAL_QA:'1',UNO_AGENCY_DB_PATH:path.join(tmp,'native.sqlite3')};
  let child,browser,storefront,logs='';const origin='http://127.0.0.1:'+port;
  async function start(){
    child=spawn(process.env.NATIVE_PYTHON||'python',['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(port),'--no-access-log'],{cwd:process.env.UNO_NATIVE_PATH,env,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
    for(let n=0;n<100;n++){try{if((await fetch(origin+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}
    throw Error('Native startup failed: '+logs.slice(-1000));
  }
  async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}}
  try{
    await start();browser=await require('playwright').chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:393,height:852},reducedMotion:'reduce'});const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/#playground_launch='+encodeURIComponent(launch.token));
    await page.waitForFunction(()=>document.getElementById('connection-status')?.textContent==='ONLINE');
    assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#gift-btn').isDisabled(),true);
    await page.locator('#boot-continue').click({timeout:30000});
    async function click(){await page.waitForFunction(()=>!document.getElementById('spin-btn').disabled);const done=page.waitForResponse(r=>r.url().endsWith('/api/agency/pick'));await page.locator('#spin-btn').click();const r=await done;assert.equal(r.status(),200);return r.json();}
    const first=await click();assert.equal(first.round.picked,1);assert.equal(first.account.balance,975);
    const rid=first.round.id;
    await stop();await start();await page.reload();
    await page.waitForFunction(()=>document.getElementById('connection-status')?.textContent==='ONLINE');
    // The boot screen is remembered by the game; only dismiss it if present.
    if(await page.locator('#boot-continue').isVisible())await page.locator('#boot-continue').click();
    const second=await click();assert.equal(second.round.id,rid);assert.equal(second.round.picked,2);
    const third=await click();assert.equal(third.round.id,rid);assert.equal(third.round.picked,3);
    const replay=await page.evaluate(async rid=>{const r=await fetch('/api/agency/state');return {status:r.status,data:await r.json()};},rid);
    assert.equal(replay.status,200);assert.equal(replay.data.account.balance,third.account.balance);
    const r=(await pool.query('SELECT * FROM agency_rounds WHERE tenant_id=$1 AND player_id=$2 AND round_ref=$3',[A.id,p.id,rid])).rows[0];
    assert.equal(r.state,'settled');assert.equal(String(r.stake),'25');assert.equal(String(r.payout),String(third.round.payout));
    assert.equal(third.account.balance,1000-25+third.round.payout);
    assert.equal((await pool.query("SELECT count(*)::int n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",[A.id,'round-close:'+r.id])).rows[0].n,1);
    const reconciliation=await ok('/api/admin/agency/tenants/'+A.id+'/reconciliation');assert.deepEqual(reconciliation.mismatches,[]);
    assert.deepEqual(errors,[]);
    fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/uno-native-wallet-mobile.png')});
    let storefrontProof=false;
    if(process.env.STOREFRONT_PATH){
      const cor=(await pool.query("SELECT * FROM agency_tenants WHERE slug='64cor'")).rows[0];
      await player(cor,'nativeCor');await topup(cor.id,10000);await paid(cor.id,'nativeCor',1000);await fund(cor.id,100000,'risk');
      await ok('/api/admin/agency/tenants/'+cor.id+'/games/'+gid,'PUT',{entitled:true,selected:true,position:1});
      await pool.query("UPDATE agency_game_releases SET launch_url='https://uno-native.qa/' WHERE game_id=$1",[gid]);
      process.env.PLAYGROUND_API_ORIGIN=base;
      ({server:storefront}=await import(require('node:url').pathToFileURL(path.join(process.env.STOREFRONT_PATH,'server.mjs')).href));
      await new Promise(r=>storefront.listen(0,'127.0.0.1',r));
      const front='http://127.0.0.1:'+storefront.address().port;
      const customer=await browser.newPage({viewport:{width:393,height:852},reducedMotion:'reduce'});
      const nativeErrors=[];customer.on('pageerror',e=>nativeErrors.push(e.message));
      await customer.route('https://chatvice.app/**',r=>r.fulfill({body:'',contentType:'application/javascript'}));
      // Local HTTPS hostname bridge only: every game request is forwarded to the
      // real FastAPI server, never replaced with fabricated game/wallet data.
      await customer.route('https://uno-native.qa/**',async route=>{
        const url=new URL(route.request().url());
        const response=await route.fetch({url:origin+url.pathname+url.search});await route.fulfill({response});
      });
      await customer.goto(front+'/user');
      await customer.locator('[data-action="auth"][data-mode="login"]').first().click();
      await customer.locator('form[data-form="auth"] [name="username"]').fill('player_nativecor');
      await customer.locator('form[data-form="auth"] [name="password"]').fill(password);
      await customer.locator('form[data-form="auth"] button[type="submit"]').click();
      await customer.locator('form[data-form="profile"]').waitFor();
      const template=JSON.parse(fs.readFileSync(path.join(process.env.STOREFRONT_PATH,'public/data.json'))).games.find(g=>g.title.toLowerCase()==='uno luck');
      await customer.goto(front+'/play/'+template.family+'/'+template.id);
      const launchResponse=customer.waitForResponse(r=>r.url().endsWith('/api/player/launch'));
      await customer.locator('.original-play').click();assert.equal((await launchResponse).status(),200);
      await customer.waitForURL('https://uno-native.qa/**');
      await customer.waitForFunction(()=>document.getElementById('connection-status')?.textContent==='ONLINE');
      assert.equal(new URL(customer.url()).hash,'');
      await customer.locator('#boot-continue').click({timeout:30000});
      let completed;
      for(let phase=1;phase<=3;phase++){
        await customer.waitForFunction(()=>!document.getElementById('spin-btn').disabled);
        const done=customer.waitForResponse(r=>r.url().endsWith('/api/agency/pick'));
        await customer.locator('#spin-btn').click();const response=await done;assert.equal(response.status(),200);completed=await response.json();assert.equal(completed.round.picked,phase);
      }
      await customer.goto(front+'/user');await customer.locator('form[data-form="profile"]').waitFor();
      const returned=await customer.evaluate(async()=>{const r=await fetch('/api/player/wallet');return r.json();});
      assert.equal(Number(returned.balances.find(b=>b.code.endsWith(':available')).amount),completed.account.balance);
      assert.deepEqual(nativeErrors,[]);
      await customer.screenshot({path:path.join(__dirname,'../test-results/64cor-native-wallet-return.png')});
      await customer.close();storefrontProof=true;
    }
    return {native:'FastAPI + persistent SQLite',browser:'Chromium 393x852',processRestart:'after first card',stake:'25',payout:String(r.payout),balance:String(third.account.balance),centralRound:r.id,settlementJournals:1,ledgerDifferences:0,environment:'isolated sandbox',productionContacted:false,storefrontLaunchAndReturn:storefrontProof};
  }finally{if(storefront)await new Promise(r=>storefront.close(r));if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
 });
};
