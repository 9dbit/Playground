'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'../public');
const gid='10000000-0000-4000-8000-000000000001';
const now=new Date().toISOString();
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const errors=[],requests=[],written=[];
 let displayName='QA Owner',cronRuns=[],read=new Set();
 const audit=[
  {id:'1',action:'game.created',actor:'qa_owner',resource:gid,created_at:now},
  {id:'2',action:'ticket.created',actor:'qa_owner',resource:'40000000-0000-4000-8000-000000000001',created_at:now}
 ];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,method=req.method();
   const files={'/engine':'control.html','/assets/control.js':'control.js','/assets/control.css':'control.css','/assets/parity.css':'parity.css','/assets/admin-ops.css':'admin-ops.css','/assets/security-nav.js':'security-nav.js','/assets/bridge-nav.js':'bridge-nav.js'};
   if(files[p]){
    const file=files[p];return route.fulfill({status:200,contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(path.join(root,file))});
   }
   requests.push(method+' '+p+u.search);
   let d,status=200;
   if(p==='/api/auth/session')d={id:'owner',username:'qa_owner',displayName,role:'owner',setupRequired:false,csrf:'qa-csrf'};
   else if(p==='/api/admin/settings')d={items:[]};
   else if(p==='/api/admin/deep/summary')d={games:{total:1,active:1},players:{total:1},tickets:{total:1,open:1},subscribers:0,published:0};
   else if(p==='/api/admin/summary')d={rounds:3,stake:'300',payout:'250'};
   else if(p==='/api/admin/deep/games')d={items:[{id:gid,name:'Skygate 5000',version:'test',status:'Active',rounds:'3'}]};
   else if(p==='/api/admin/ops/notifications'&&method==='GET'){
    const items=audit.map(x=>({...x,is_read:read.has(x.id)}));
    d={items:items.slice(0,Number(u.searchParams.get('limit')||20)),unread:items.filter(x=>!x.is_read).length,note:'Local audited activity only'};
   }
   else if(p==='/api/admin/ops/notifications/read-all'&&method==='POST'){
    audit.forEach(x=>read.add(x.id));d={ok:true,marked:audit.length};
   }
   else if(/^\/api\/admin\/ops\/notifications\/\d+\/read$/.test(p)&&method==='POST'){
    read.add(p.split('/').at(-2));d={ok:true};
   }
   else if(p==='/api/admin/ops/search'){
    d={query:u.searchParams.get('q'),items:[{type:'Game',label:'Skygate 5000',route:'game/'+gid,subtitle:'skygate-5000 · Active'}]};
   }
   else if(p==='/api/admin/ops/profile'&&method==='GET'){
    d={item:{username:'qa_owner',displayName,role:'owner',status:'active',mfaEnabled:true}};
   }
   else if(p==='/api/admin/ops/profile'&&method==='PUT'){
    const body=req.postDataJSON();written.push({type:'profile',body});displayName=body.displayName;
    d={ok:true,item:{displayName}};
   }
   else if(p==='/api/admin/ops/cron'&&method==='GET'){
    d={enabled:false,intervalMinutes:10,lastRun:cronRuns[0]||null,history:cronRuns,
     note:'Local session cleanup only',externalVendorCron:false};
   }
   else if(p==='/api/admin/ops/cron/run'&&method==='POST'){
    const latest={id:String(cronRuns.length+1),actor:'qa_owner',status:'completed',cleaned_revocations:1,cleaned_sessions:0,started_at:now};
    cronRuns.unshift(latest);written.push({type:'cron',latest});
    d={ok:true,status:'completed',run:latest};
   }
   else if(p==='/api/admin/deep/reports/transactions'){
    const result=u.searchParams.get('result')||'all';
    const rounds=[
     {id:'11',event_id:'qa1',round_id:'r1',game:'Skygate 5000',stake:'100',payout:'150',result:'win',currency:'DEMO_COIN',occurred_at:now},
     {id:'12',event_id:'qa2',round_id:'r2',game:'Skygate 5000',stake:'100',payout:'0',result:'loss',currency:'DEMO_COIN',occurred_at:now}
    ];
    d={items:rounds.filter(x=>result==='all'||result===x.result),notice:'Derived stake/payout result only'};
   }
   else if(p==='/api/admin/deep/games/'+gid) {
    d={item:{id:gid,name:'Skygate 5000',code:'SK',platform:'Web',status:'Active',rounds:'3',demo_chance:50,winning_chance:50,win_amount:50,invest_enabled:false,
     min_invest:1,max_invest:100,trending:false,featured:false,instructions:'Demo instructions',version:1}};
   }
   else {status=404;d={error:'Unmocked '+method+' '+p}};
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(d)});
  });
  await page.goto('http://127.0.0.1:8777/engine');
  await page.getByRole('heading',{name:'Dashboard'}).waitFor();
  await page.locator('#notif-count').getByText('2').waitFor();
  await page.locator('[data-action=search]').click();
  await page.locator('#global-query').fill('Sky');
  await page.locator('#global-results').getByText('Skygate 5000').waitFor();
  assert.equal(await page.locator('#global-results .result').count()>0,true);
  await page.locator('[data-action=close]').click();
  await page.locator('.topbar [data-go=activity]').click();
  await page.getByRole('heading',{name:'Notification Center'}).waitFor();
  assert.match(await page.locator('.main').innerText(),/2 unread/);
  await page.locator('[data-action=activity-read]').first().click();
  await page.getByText('1 unread').waitFor();
  await page.locator('[data-action=activity-read-all]').click();
  await page.getByText('0 unread').waitFor();
  await page.locator('.topbar [data-go=profile]').click();
  await page.getByRole('heading',{name:'Administrator Profile'}).waitFor();
  assert.equal(await page.locator('#profile-save input[name=username]').count(),0);
  assert.equal(await page.locator('a[href="/security"]').count(),1);
  await page.locator('#profile-save input[name=displayName]').fill('QA Operator');
  await page.locator('#profile-save button[type=submit]').click();
  await page.locator('#profile-save input[name=displayName]').waitFor();
  assert.equal(written.find(x=>x.type==='profile')?.body.displayName,'QA Operator');
  await page.evaluate(()=>location.hash='#/cron');
  await page.getByRole('heading',{name:'Cron Setup'}).waitFor();
  await page.locator('[data-action=cron-run]').click();
  await page.getByText('completed',{exact:true}).first().waitFor();
  assert.equal(written.filter(x=>x.type==='cron').length,1);
  await page.evaluate(()=>location.hash='#/report/transactions/win');
  await page.getByRole('heading',{name:'Transaction History'}).waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),1);
  assert.match(await page.locator('.table tbody').innerText(),/qa1/);
  assert.equal(requests.some(x=>x.includes('/deep/reports/transactions?result=win')),true);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  fs.mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/cp11-admin-mobile.png',fullPage:true});
  assert.deepEqual(errors,[],'No browser JS errors');
  const report={result:'PASS',checks:['Dashboard notification unread badge','global database search','mark read and mark all','administrator profile read/write','manual cron and history','derived net result filter','390px viewport without horizontal overflow'],errors,writeCount:written.length};
  fs.writeFileSync('test-results/cp11-admin-ui.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
