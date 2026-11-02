'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../public');
const gid='10000000-0000-4000-8000-000000000001',pid='20000000-0000-4000-8000-000000000001';
const player={id:pid,player_ref:'qa-demo-player',game_id:gid,game:'QA Game',rounds:'2',first_name:'QA',last_name:'Player',
 city:'',state:'',zip:'',country:'',admin_note:'',local_status:'active',version:1,total_played:'150',total_win:'70',net_return:'-80'};
const game={id:gid,name:'QA Game',code:'QA',platform:'Web',build_version:'1.0',status:'Maintenance',rounds:'2',
 demo_chance:50,winning_chance:50,win_amount:50,invest_enabled:false,min_invest:1,max_invest:100,trending:false,featured:false,instructions:'QA',has_image:false,version:1};
const snapshot={balance:'100',entries:[]};
const items=[
 {group:'System Setting',name:'General Setting',route:'setting/general',kind:'setting',status:'partial',notes:'Not all bonus functions active'},
 {group:'Manage Users',name:'Login as User',route:'players/all',kind:'function',status:'blocked',notes:'Impersonation disabled'},
 {group:'Manage Users',name:'Virtual Balance',route:'wallet/'+pid,kind:'function',status:'partial',notes:'Internal DEMO_COIN'}
];
(async()=>{
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[],writes=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname;
  const files={'/engine':'control.html','/assets/control.js':'control.js','/assets/control.css':'control.css','/assets/parity.css':'parity.css','/assets/security-nav.js':'security-nav.js','/assets/bridge-nav.js':'bridge-nav.js'};
  if(files[p]){
   const file=files[p];return route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(root,file))});
  }
  const session={username:'qa_owner',displayName:'QA Owner',role:'owner',setupRequired:false,development:false,csrf:'qa-csrf'};
  let data,status=200;
  if(p==='/api/auth/session')data=session;
  else if(p==='/api/admin/settings')data={items:[]};
  else if(p==='/api/admin/summary')data={rounds:2,stake:'150',payout:'70'};
  else if(p==='/api/admin/deep/summary')data={games:{total:1,active:0},players:{total:1},tickets:{total:0,open:0},subscribers:0,published:0};
  else if(p==='/api/admin/deep/games')data={items:[game]};
  else if(p==='/api/admin/deep/games/'+gid){data={item:game}}
  else if(p==='/api/admin/deep/players/'+pid)data={item:player};
  else if(p==='/api/admin/deep/players?state=all')data={items:[player]};
  else if(p==='/api/admin/virtual-wallets/'+pid){
   if(req.method()==='GET')data={player:{id:pid,player_ref:player.player_ref,game_id:gid},balance:snapshot.balance,
     entries:snapshot.entries,currency:'DEMO_COIN',externalWalletConnected:false,notice:'Internal virtual wallet only'};
   else{status=404;data={error:'Unknown wallet method'}}
  }else if(p==='/api/admin/parity')data={version:'checkpoint-10',counts:{partial:2,blocked:1},items,
    service:{database:'connected',adminAccounts:true,gameProfiles:true,virtualWallet:true,externalGameWallet:false,playerIdentityProvider:false,kycProvider:false,paymentProvider:false}};
  else if(req.method()==='PUT'&&p==='/api/admin/deep/games/'+gid){
   const body=req.postDataJSON();writes.push({type:'game',body});Object.assign(game,body,{version:2});data={ok:true,version:2};
  }else if(req.method()==='POST'&&p==='/api/admin/virtual-wallets/'+pid+'/adjust'){
   const body=req.postDataJSON();writes.push({type:'wallet',body});snapshot.balance=String(Number(snapshot.balance)+(body.action==='credit'?body.amount:-body.amount));
   snapshot.entries.unshift({id:'1',action:'admin_'+body.action,delta:String(body.amount),balance_after:snapshot.balance,
     actor:'qa_owner',note:body.note,created_at:new Date().toISOString()});
   data={ok:true,balance:snapshot.balance,operationId:'1'};
  }else {status=404;data={error:'Unmocked '+p+u.search}}
  return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8777/engine');
 await page.locator('h1').getByText('Dashboard').waitFor();
 await page.evaluate(()=>location.hash='#/parity');await page.getByRole('heading',{name:'Functional QA · Xaxino Parity'}).waitFor();
 assert.equal(await page.locator('.parity-row').count(),3);
 assert.equal(await page.locator('.parity-row[hidden]').count(),0);
 await page.locator('#parity-status').selectOption('blocked');
 assert.equal(await page.locator('.parity-row[hidden]').count(),2);
 await page.locator('#parity-status').selectOption('');
 await page.locator('#parity-search').fill('virtual');
 assert.equal(await page.locator('.parity-row[hidden]').count(),2);
 await page.evaluate(x=>location.hash='#/game/'+x,gid);
 await page.locator('#game-edit').waitFor();
 assert.equal(await page.locator('input[name=winning_chance]').count(),1);
 assert.equal(await page.locator('input[name=demo_chance]').count(),1);
 assert.equal(await page.locator('input[name=win_amount]').count(),1);
 await page.locator('input[name=winning_chance]').fill('55');
 await page.locator('input[name=win_amount]').fill('65');
 await page.locator('#game-edit button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('input[name=version]')?.value==='2');
 assert.equal(writes.find(x=>x.type==='game')?.body.winning_chance,55);
 assert.equal(writes.find(x=>x.type==='game')?.body.win_amount,65);
 await page.evaluate(x=>location.hash='#/player/'+x,pid);
 await page.locator('#player-edit').waitFor();
 assert.match(await page.locator('.stats').innerText(),/Virtual Balance/);
 await page.locator('[data-action=wallet-credit]').first().click();
 await page.locator('#modal-form').waitFor();
 await page.locator('#modal-form input[name=amount]').fill('35');
 await page.locator('#modal-form input[name=note]').fill('QA internal ledger test');
 await page.locator('#modal-form button[type=submit],#modal-form button.btn').last().click();
 await page.getByRole('heading',{name:/Virtual Wallet/}).waitFor();
 assert.match(await page.locator('.stats').innerText(),/135/);
 assert.equal(writes.find(x=>x.type==='wallet')?.body.amount,35);
 assert.ok(writes.find(x=>x.type==='wallet')?.body.idempotency_key);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 fs.mkdirSync('test-results',{recursive:true});
 await page.screenshot({path:'test-results/parity-wallet-mobile.png',fullPage:true});
 assert.equal(errors.length,0,'No JS errors');
 const report={result:'PASS',checks:['functional QA visibility/filter','three distinct game demo fields save','player wallet drilldown','audited adjustment payload','390px no overflow'],errors};
 fs.writeFileSync('test-results/parity-ui.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
