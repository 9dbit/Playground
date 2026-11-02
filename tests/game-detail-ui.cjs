'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'../public');
const gameId='10000000-0000-4000-8000-000000000001';
const playerId='20000000-0000-4000-8000-000000000001';
const game={id:gameId,name:'QA Test Game',code:'QA',platform:'Browser',version:1,build_version:'1.0',
 status:'Maintenance',rounds:'56',demo_chance:50,winning_chance:50,win_amount:50,invest_enabled:false,
 min_invest:1,max_invest:100,trending:false,featured:false,instructions:'Synthetic QA instructions',has_image:false};
const player={id:playerId,player_ref:'qa-player-1',game_id:gameId,game:'QA Test Game',rounds:'56',
 first_name:'QA',last_name:'Player',city:'',state:'',zip:'',country:'',admin_note:'',local_status:'active',
 version:1,total_played:'5600',total_win:'6800',net_return:'1200'};
const rounds=Array.from({length:56},(_,index)=>{
 const i=56-index,result=i%2===0?'win':'loss';
 return {id:String(i),event_id:'event-'+i,round_id:'R-'+String(i).padStart(3,'0'),game:game.name,
 player_ref:'qa-player-1',player_id:playerId,stake:'100',payout:result==='win'?'150':'50',
 result,currency:'DEMO_COIN',occurred_at:new Date('2026-11-02T00:00:00Z').toISOString()};
});
function filteredRounds(url,onlyPlayer){
 const type=url.searchParams.get('result')||'all';
 const term=(url.searchParams.get('q')||'').toLowerCase();
 const page=Math.max(1,Number(url.searchParams.get('page')||1));
 const limit=Number(url.searchParams.get('limit')||25);
 let arr=rounds.filter(x=>!onlyPlayer || x.player_ref==='qa-player-1');
 arr=arr.filter(x=>(type==='all'||x.result===type)&&(!term||[x.event_id,x.round_id,x.player_ref].some(z=>z.toLowerCase().includes(term))));
 return {items:arr.slice((page-1)*limit,page*limit),page,limit,total:arr.length,
 pages:Math.ceil(arr.length/limit),hasNext:page*limit<arr.length,filters:{q:term,result:type},
 roundsReadOnly:true,externalSettlementVerified:false,
 note:'Synthetic signed observed events only; not actual vendor settlement.'};
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const errors=[],requests=[],writes=[];
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname;
   const files={'/engine':'control.html','/assets/control.js':'control.js','/assets/control.css':'control.css',
     '/assets/parity.css':'parity.css','/assets/admin-ops.css':'admin-ops.css',
     '/assets/security-nav.js':'security-nav.js','/assets/bridge-nav.js':'bridge-nav.js'};
   if(files[p])return route.fulfill({status:200,
    contentType:p==='/engine'?'text/html':p.endsWith('.css')?'text/css':'application/javascript',
    body:fs.readFileSync(path.join(root,files[p]))});
   requests.push(req.method()+' '+p+u.search);
   let data,status=200;
   if(p==='/api/auth/session')data={username:'qa_owner',displayName:'QA',role:'owner',setupRequired:false,csrf:'qa-token'};
   else if(p==='/api/admin/settings')data={items:[]};
   else if(p==='/api/admin/ops/notifications')data={items:[],unread:0,note:'Synthetic QA'};
   else if(p==='/api/admin/deep/summary')data={games:{total:1,active:0},players:{total:1},tickets:{total:0},subscribers:0};
   else if(p==='/api/admin/summary')data={rounds:56,stake:'5600',payout:'6800'};
   else if(p==='/api/admin/deep/games')data={items:[game]};
   else if(p==='/api/admin/deep/games/'+gameId && req.method()==='GET')data={item:game};
   else if(p==='/api/admin/deep/games/'+gameId && req.method()==='PUT'){
    const body=req.postDataJSON();writes.push(body);Object.assign(game,body,{version:game.version+1});data={ok:true,version:game.version,externalEngineAffected:false};
   }
   else if(p==='/api/admin/deep/games/'+gameId+'/rounds')data=filteredRounds(u,false);
   else if(p==='/api/admin/deep/players/'+playerId+'/rounds')data=filteredRounds(u,true);
   else if(p==='/api/admin/deep/players/'+playerId)data={item:player};
   else if(p==='/api/admin/virtual-wallets/'+playerId)data={player:{id:playerId,player_ref:player.player_ref,game_id:gameId},
    balance:'100',entries:[],currency:'DEMO_COIN',externalWalletConnected:false};
   else {status=404;data={error:'Unmocked '+p+u.search}}
   return route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://127.0.0.1:8777/engine');
  await page.getByRole('heading',{name:'Dashboard'}).waitFor();
  await page.evaluate(()=>location.hash='#/games');
  await page.getByRole('heading',{name:'Manage Games'}).waitFor();
  await page.locator('[data-go="game-rounds/'+gameId+'"]').first().click();
  await page.getByRole('heading',{name:/Game Log · QA Test Game/}).waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),25);
  assert.match(await page.locator('.paging-controls').innerText(),/Page 1 \/ 3/);
  await page.locator('.paging-controls [data-go$="/all/2"]').click();
  await page.getByText('Page 2 / 3').waitFor();
  await page.locator('.table tbody tr').first().getByText('event-31').waitFor();
  await page.locator('.paging-controls [data-go$="/all/1"]').click();
  await page.getByText('Page 1 / 3').waitFor();
  await page.locator('#game-log-filter input[name=q]').fill('R-002');
  await page.locator('#game-log-filter button[type=submit]').click();
  await page.getByText('1 observed records').waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),1);
  assert.match(await page.locator('.table tbody').innerText(),/R-002/);
  await page.locator('[data-action=game-log-clear]').click();
  await page.getByText('56 observed records').waitFor();
  await page.locator('[data-go$="/win/1"]').first().click();
  await page.getByText('28 observed records').waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),25);
  await page.locator('.paging-controls [data-go$="/win/2"]').click();
  await page.getByText('Page 2 / 2').waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),3);
  await page.evaluate(x=>location.hash='#/game/'+x,gameId);
  await page.locator('#game-edit').waitFor();
  await page.locator('input[name=winning_chance]').fill('62');
  await page.locator('input[name=win_amount]').fill('31');
  await page.locator('#game-edit button[type=submit]').click();
  await page.locator('input[name=version][value="2"]').waitFor({state:'attached'});
  assert.equal(writes[0].winning_chance,62);
  assert.equal(writes[0].win_amount,31);
  assert.equal(game.winning_chance,62);
  assert.equal(game.win_amount,31);
  await page.evaluate(x=>location.hash='#/player/'+x,playerId);
  await page.getByRole('heading',{name:/User Detail/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Player Logins unavailable'}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Player Notifications unavailable'}).isDisabled(),true);
  await page.evaluate(x=>location.hash='#/player-rounds/'+x,playerId);
  await page.getByRole('heading',{name:'Player Rounds'}).waitFor();
  assert.equal(await page.locator('.table tbody tr').count(),25);
  await page.locator('.paging-controls [data-go$="/2"]').click();
  await page.getByText('Page 2 / 3').waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  fs.mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/cp12-game-log-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  const report={result:'PASS',checks:['game list to scoped Game Log','next and previous pagination','literal round search','clear search','net result filters','game demo metadata save/readback','player-only round drilldown','player identity provider actions disabled','390px responsive'],requests:requests.length,errorCount:errors.length};
  fs.writeFileSync('test-results/cp12-game-ui.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
