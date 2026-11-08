'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
module.exports=async({pool,check,player,A,topup,paid,fund,password,ok,req,creds,base,gameSecret})=>{
 for(const game of [
  {name:'Mahjong',slug:'mahjong-wild',key:'qa-mahjong',repo:process.env.MAHJONG_NATIVE_PATH,db:'MAHJONG_AGENCY_DB_PATH',route:'/',spin:'/api/spin',button:'#spin-btn',title:'mahjong wild',python:true},
  {name:'Skygate',slug:'skygate-5000',key:'qa-skygate',repo:process.env.SKYGATE_NATIVE_PATH,db:'SKYGATE_AGENCY_DB_PATH',route:'/play/',spin:'/api/agency/spin',button:'#spin',title:'skygate 5000'}]){
  if(!game.repo)continue;
  await check('NATIVE_'+game.name.toUpperCase(),game.name+' real 64COR launch, mobile spin, restart and central ledger reconciliation',async()=>{
   const cor=(await pool.query("SELECT * FROM agency_tenants WHERE slug='64cor'")).rows[0],label='native'+game.name.toLowerCase();
   const p=await player(cor,label);await topup(cor.id,10000);await paid(cor.id,label,1000);await fund(cor.id,100000,'risk');
   const gid=(await pool.query('SELECT id FROM gameops_games WHERE slug=$1',[game.slug])).rows[0].id;
   const host='https://'+game.slug+'-native.qa';
   await pool.query("UPDATE gameops_games SET status='Active' WHERE id=$1",[gid]);
   await pool.query("UPDATE agency_game_releases SET readiness='publishable',launch_url=$2 WHERE game_id=$1",[gid,host+game.route]);
   await ok('/api/admin/agency/tenants/'+cor.id+'/games/'+gid,'PUT',{entitled:true,selected:true,position:2});
   const net=require('node:net').createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const port=net.address().port;await new Promise(r=>net.close(r));
   const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'native-slots-')),origin='http://127.0.0.1:'+port;
   const env={...process.env,PORT:String(port),AGENCY_WALLET_MODE:'sandbox',AGENCY_WALLET_ORIGIN:base,AGENCY_WALLET_KEY_ID:game.key,AGENCY_WALLET_SECRET:gameSecret,AGENCY_WALLET_LOCAL_QA:'1',AGENCY_STUDIO_SYNC:'1',[game.db]:path.join(tmp,'wallet.sqlite'),SKYGATE_RELEASE_DIR:path.join(tmp,'releases')};
   let child,browser,storefront,logs='';
   async function start(){child=spawn(game.python?(process.env.NATIVE_PYTHON||'python'):process.execPath,game.python?['-m','uvicorn','agency_runtime:app','--host','127.0.0.1','--port',String(port),'--no-access-log']:['server.mjs'],{cwd:game.repo,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Native boot failed '+logs.slice(-1200));}
   async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}}
   try{
    await start();browser=await require('playwright').chromium.launch({headless:true,args:['--no-sandbox']});
    process.env.PLAYGROUND_API_ORIGIN=base;({server:storefront}=await import(require('node:url').pathToFileURL(path.join(process.env.STOREFRONT_PATH,'server.mjs')).href));await new Promise(r=>storefront.listen(0,'127.0.0.1',r));
    const frontLocal='http://127.0.0.1:'+storefront.address().port,front='https://playground-agent-frontend-production.up.railway.app',page=await browser.newPage({viewport:{width:393,height:852},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',e=>{errors.push(e.message);logs+='\nPAGEERROR '+e.stack;});page.on('console',e=>{if(e.type()==='error')logs+='\nBROWSER '+e.text();});
    // All storefront traffic stays on the disposable local server, including
    // return-button navigation to the centrally configured canonical origin.
    await page.route(front+'/**',async route=>{const url=new URL(route.request().url()),headers={...route.request().headers()};if(headers.origin===front)headers.origin=frontLocal;try{const response=await route.fetch({url:frontLocal+url.pathname+url.search,headers});await route.fulfill({response});}catch{await route.abort().catch(()=>{});}});
    await page.route('https://chatvice.app/**',r=>r.fulfill({body:'',contentType:'application/javascript'}));
    await page.route(host+'/**',async route=>{const url=new URL(route.request().url()),headers={...route.request().headers()};if(headers.origin===host)headers.origin=origin;try{const response=await route.fetch({url:origin+url.pathname+url.search,headers});await route.fulfill({response});}catch{await route.abort().catch(()=>{});}});
    await page.goto(front+'/user');await page.locator('[data-action="auth"][data-mode="login"]').first().click();await page.locator('form[data-form="auth"] [name="username"]').fill('player_'+label);await page.locator('form[data-form="auth"] [name="password"]').fill(password);await page.locator('form[data-form="auth"] button[type="submit"]').click();await page.locator('form[data-form="profile"]').waitFor();
    const template=JSON.parse(fs.readFileSync(path.join(process.env.STOREFRONT_PATH,'public/data.json'))).games.find(g=>g.title.toLowerCase()===game.title);assert.ok(template,'Storefront template exists');
    await page.goto(front+'/play/'+template.family+'/'+template.id);const launched=page.waitForResponse(r=>r.url().endsWith('/api/player/launch'));await page.locator('.original-play').click();assert.equal((await launched).status(),200);await page.waitForURL(host+'/**');
    if(game.python){await page.waitForFunction(()=>window.MahjongStudioRuntime?.manifest);assert.equal(await page.locator('#reset-btn').isVisible(),false);const splash=page.locator('#soft-tech-continue');if(await splash.count())await splash.click({timeout:30000});}
    else{await page.waitForFunction(()=>window.SlotGameTest&&window.SkygateAgency);assert.equal(await page.locator('#reset').isVisible(),false);await page.evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(x=>x.close());window.SkygateBoot?.dismiss?.();});const boot=page.locator('#bootPlay');if(await boot.isVisible())await boot.click();}
    assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.locator('#agency-return').getAttribute('href'),front+'/');
    assert.equal(await page.locator('#agency-session-notice').isVisible(),false);
    fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/'+game.slug+'-native-return.png')});
    // Actual user click executes the real renderer's native request.
    await page.locator(game.button).waitFor();const responsePromise=page.waitForResponse(r=>r.url().endsWith(game.spin)&&r.request().method()==='POST');await page.locator(game.button).click({timeout:30000});const response=await responsePromise;assert.equal(response.status(),200,await response.text());const result=await response.json(),payload=JSON.parse(response.request().postData());
    const payout=Number(game.python?result.win_virtual_credits:result.payout),stake=Number(game.python?result.stake_virtual_credits:result.cost),initialExpected=1000-stake+payout;let expected=initialExpected,expectedRounds=1;
    assert.equal(Number(result.state.balance),expected);
    const {studioRelease,rollbackStudio,closeStudio}=await require('./agency-studio-native.cjs')({pool,ok,req,creds,password,base,browser,game});
    await page.goto('about:blank');await stop();await start();await page.goto(host+game.route);
    if(game.python)await page.waitForFunction(()=>window.MahjongStudioRuntime?.manifest);else await page.waitForFunction(()=>window.SlotGameTest&&window.SkygateAgency);
    if(game.python)await page.locator('#soft-tech-continue').click({timeout:30000});else await page.locator('#bootPlay').click({timeout:30000});
    const retry=await page.evaluate(async({url,payload,python})=>{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(python?{'X-ML-Request':'local-demo'}:{'X-Skygate-Client':'agency-ui'})},body:JSON.stringify(payload)});return {status:r.status,data:await r.json()};},{url:game.spin,payload,python:game.python});assert.equal(retry.status,200);assert.equal(Number(retry.data.state.balance),expected);
    if(!game.python){
      for(const mode of ['buy','ante']){
        await page.waitForFunction(()=>!window.SlotGameTest.getState().busy);
        const received=page.waitForResponse(r=>r.url().endsWith(game.spin)&&r.request().method()==='POST');
        received.catch(()=>{}); // Report a control failure without an unhandled timeout.
        if(mode==='buy'){await page.locator('#buyFeature').click();await page.locator('#confirmBuy').click();}
        else{await page.locator('#anteFeature').click();await page.locator('#spin').click();}
        const response=await received;assert.equal(response.status(),200,await response.text());const next=await response.json();
        assert.equal(next.buy_bonus,mode==='buy');assert.equal(next.ante,mode==='ante');expected=expected-Number(next.cost)+Number(next.payout);assert.equal(Number(next.state.balance),expected);expectedRounds++;
      }
      await page.waitForFunction(()=>!window.SlotGameTest.getState().busy);
    }
    let leavingResult,releaseResponse,receivedResponse;
    const responseHeld=new Promise(r=>receivedResponse=r),releaseHeld=new Promise(r=>releaseResponse=r);
    await page.route(host+game.spin,async route=>{const headers={...route.request().headers(),origin};const response=await route.fetch({url:origin+game.spin,headers});assert.equal(response.status(),200);leavingResult=await response.json();receivedResponse();await releaseHeld;await route.fulfill({response}).catch(()=>{});});
    await page.locator(game.button).click();await responseHeld;
    expected=expected-Number(game.python?leavingResult.stake_virtual_credits:leavingResult.cost)+Number(game.python?leavingResult.win_virtual_credits:leavingResult.payout);expectedRounds++;
    await page.locator('#agency-return').click();await page.waitForURL(front+'/');await page.locator('#main').waitFor();releaseResponse();await page.unroute(host+game.spin);
    await page.goto(front+'/user');await page.locator('form[data-form="profile"]').waitFor();
    const afterLeave=await page.evaluate(()=>fetch('/api/player/wallet').then(r=>r.json()));assert.equal(Number(afterLeave.balances.find(b=>b.code.endsWith(':available')).amount),expected);
    if(game.python)assert.equal(leavingResult.state.manifest.presentation.animation_speed,1.1);
    else assert.equal(leavingResult.state.release_id,studioRelease);
    await rollbackStudio();await closeStudio();
    // Expiry blocks a new spin but retains the canonical return path and history.
    await pool.query("UPDATE agency_launches SET expires_at=now()-interval '1 second' WHERE tenant_id=$1 AND player_id=$2",[cor.id,p.id]);
    await page.goto(host+game.route);await page.waitForFunction(()=>window.PlaygroundNavigation&&!window.PlaygroundNavigation.canStart());
    await page.locator('#agency-session-notice').waitFor();assert.match(await page.locator('#agency-session-notice').innerText(),/Sesi game berakhir/);
    assert.equal(await page.locator('#agency-return').getAttribute('href'),front+'/');
    const rounds=(await pool.query('SELECT * FROM agency_rounds WHERE tenant_id=$1 AND player_id=$2 AND game_id=$3',[cor.id,p.id,gid])).rows;assert.equal(rounds.length,expectedRounds);assert.ok(rounds.every(r=>r.state==='settled'));
    const journals=(await pool.query('SELECT count(*)::int n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2',[cor.id,'round-close:'+rounds[0].id])).rows[0].n;assert.equal(journals,1);
    for(const round of rounds)assert.equal((await pool.query('SELECT count(*)::int n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2',[cor.id,'round-close:'+round.id])).rows[0].n,1);
    assert.deepEqual((await ok('/api/admin/agency/tenants/'+cor.id+'/reconciliation')).mismatches,[]);assert.deepEqual(errors,[]);
    fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-results/'+game.slug+'-native.png')});
    await page.locator('#agency-return').click();await page.waitForURL(front+'/');await page.locator('#main').waitFor();
    await page.goto(front+'/user');await page.locator('form[data-form="profile"]').waitFor();const wallet=await page.evaluate(()=>fetch('/api/player/wallet').then(r=>r.json()));assert.equal(Number(wallet.balances.find(b=>b.code.endsWith(':available')).amount),expected);
    return {environment:'isolated sandbox',storefrontLaunchAndReturn:true,browser:'Chromium 393x852',restart:true,studioPublication:true,studioRollback:true,publicationSurvivesRestart:true,returnButton:true,unknownResponseThenLeave:true,expiredSessionGuidance:true,settledRounds:expectedRounds,settlementJournalsPerRound:1,ledgerDifferences:0,productionContacted:false};
   }catch(e){fs.writeFileSync('/tmp/'+game.slug+'-uat.log',logs);throw e;}
   finally{if(storefront)await new Promise(r=>storefront.close(r));if(browser)await browser.close();await stop();fs.rmSync(tmp,{recursive:true,force:true});}
  });
 }
};
