'use strict';
// Browser-only fake transport for the isolated static UI simulator.
// Never forwards a request to production, a server API, or another origin.
(()=>{
const KEY='playground-isolated-ui-fixtures-v1';
const uuid=()=>crypto.randomUUID();
const now=()=>new Date().toISOString();
function seed(){
 const games=['Skygate 5000','UNO LUCK','Mahjong Wild'].map((name,i)=>({id:`10000000-0000-4000-8000-00000000000${i+1}`,name:name+' [DEMO]',slug:['skygate-5000','uno-luck','mahjong-wild'][i],code:['SK','UN','MW'][i],platform:'Browser fixture',build_version:'simulation',version:1,status:'Maintenance',rounds:'2',demo_chance:50,winning_chance:50,win_amount:50,invest_enabled:false,min_invest:1,max_invest:1000,trending:false,featured:false,instructions:'Synthetic instructions for UI testing only.',has_image:false,image:null}));
 const players=games.map((g,i)=>({id:`20000000-0000-4000-8000-00000000000${i+1}`,game_id:g.id,game:g.name,player_ref:'demo-player-'+(i+1),first_name:'Demo',last_name:String(i+1),city:'',state:'',zip:'',country:'',admin_note:'Synthetic fixture. Not a customer.',local_status:'active',version:1,rounds:'2',total_played:'800',total_win:'600',net_return:'-200',last_seen:now()}));
 const rounds=games.flatMap((g,i)=>[0,1].map(j=>({id:String(i*2+j+1),event_id:`demo-event-${i}-${j}`,round_id:`demo-round-${i}-${j}`,game:g.name,game_id:g.id,player_ref:players[i].player_ref,stake:'400',payout:j?'0':'600',currency:'DEMO_COIN',occurred_at:now(),ingested_at:now()})));
 return {games,players,rounds,wallets:players.map(p=>({id:p.id,player_id:p.id,balance:'100',entries:[]})),walletOperations:[],adminActivity:[{id:'1',actor:'sandbox-demo',action:'game.created',resource:games[0].id,created_at:now()},{id:'2',actor:'sandbox-demo',action:'ticket.created',resource:'40000000-0000-4000-8000-000000000001',created_at:now()}],activityRead:[],profile:{displayName:'Sandbox Administrator'},cronRuns:[],requests:[{id:'30000000-0000-4000-8000-000000000001',player_ref:'demo-player-1',amount:'1000',status:'pending',note:'Synthetic request',created_at:now(),reviewed_at:null}],tickets:[{id:'40000000-0000-4000-8000-000000000001',subject:'DEMO: test ticket workflow',requester_ref:'demo-player-1',priority:'Medium',status:'Open',created_at:now(),messages:[]}],subscribers:[{id:uuid(),contact:'demo@example.invalid',status:'subscribed',created_at:now()}],notifications:[],audit:[],settings:[{key:'general',value:{site_title:'Playground SANDBOX',base_color:'#4939f5',currency:'DEMO_COIN'},version:1,updated_at:now()}],content:['page','policy','template','frontend'].map(kind=>({id:uuid(),kind,slug:'demo-'+kind,title:'Demo '+kind,body:'Synthetic content. Nothing here is published to production.',status:'draft',version:1,created_at:now(),updated_at:now()}))};
}
let db;
try{const parsed=JSON.parse(sessionStorage.getItem(KEY)||'null');db=parsed&&Array.isArray(parsed.games)&&Array.isArray(parsed.content)?parsed:seed();}catch{db=seed();}
if(!Array.isArray(db.wallets))db.wallets=db.players.map(p=>({id:p.id,player_id:p.id,balance:'100',entries:[]}));
db.wallets.forEach(w=>{if(!w.id)w.id=w.player_id});
if(!Array.isArray(db.walletOperations))db.walletOperations=[];
if(!Array.isArray(db.adminActivity))db.adminActivity=seed().adminActivity;
if(!Array.isArray(db.activityRead))db.activityRead=[];
if(!db.profile)db.profile={displayName:'Sandbox Administrator'};
if(!Array.isArray(db.cronRuns))db.cronRuns=[];
function save(){try{sessionStorage.setItem(KEY,JSON.stringify(db));}catch{throw Object.assign(Error('Browser fixture storage is full. Use Reset data uji.'),{status:507});}}
function error(message,status=400){throw Object.assign(Error(message),{status});}
function one(items,id){const item=items.find(x=>x.id===id);if(!item)error('Synthetic record not found',404);return item;}
function log(action){db.audit.unshift({id:uuid(),actor:'sandbox-demo',action,resource:'browser-only',details:{simulation:true},created_at:now()});db.audit=db.audit.slice(0,100);}
function response(data,status=200){return new Response(JSON.stringify({...data,sandbox:true,productionConnected:false}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Playground-Simulation':'true'}});}
function matches(pattern,p){return p.match(pattern);}

function roundPageFixtures(source,url){
 const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||25);
 const result=url.searchParams.get('result')||'all',q=(url.searchParams.get('q')||'').trim().toLowerCase();
 if(!Number.isSafeInteger(page)||page<1||page>1000||!Number.isSafeInteger(limit)||limit<1||limit>100||
   !['all','win','loss','draw'].includes(result)||q.length>80)error('Invalid observed round filters');
 const rows=source.map(x=>({...x,player_id:db.players.find(p=>p.game_id===x.game_id&&p.player_ref===x.player_ref)?.id,
   result:Number(x.payout)>Number(x.stake)?'win':Number(x.payout)<Number(x.stake)?'loss':'draw'}))
   .filter(x=>(result==='all'||x.result===result)&&(!q||[x.round_id,x.event_id,x.player_ref].some(y=>y.toLowerCase().includes(q))))
   .sort((a,b)=>Number(b.id)-Number(a.id));
 return {items:rows.slice((page-1)*limit,page*limit),total:rows.length,page,limit,pages:Math.ceil(rows.length/limit),
  hasNext:page*limit<rows.length,filters:{q,result},roundsReadOnly:true,externalSettlementVerified:false,
  note:'SIMULATION: browser-only virtual observations, no actual settlement.'};
}

window.fetch=async(input,opts={})=>{
 try{
  const u=new URL(typeof input==='string'?input:input.url,location.origin);
  if(u.origin!==location.origin)error('This isolated simulator cannot contact other origins',403);
  const p=u.pathname,m=String(opts.method||'GET').toUpperCase();let b={};
  if(opts.body){if(typeof opts.body!=='string'||opts.body.length>750000)error('Fixture request too large',413);b=JSON.parse(opts.body);}
  let result,match;
  if(p==='/api/auth/session')return response({username:'sandbox-demo',displayName:'Browser UI fixture',role:'owner',setupRequired:false,csrf:'fixture-placeholder-no-server-authority',authenticationMethod:'none-static-simulator'});
  if(p==='/api/auth/logout'){db=seed();save();return response({ok:true});}
  if(p.startsWith('/api/security/')||p.startsWith('/api/v'))error('No account security or game ingestion in this simulator',403);
  if(m==='GET'){
   if(p==='/api/admin/summary'){const stake=db.rounds.reduce((a,x)=>a+Number(x.stake),0),payout=db.rounds.reduce((a,x)=>a+Number(x.payout),0);result={gameCount:db.games.length,activeGames:db.games.filter(x=>x.status==='Active').length,players:db.players.length,pendingRequests:db.requests.filter(x=>x.status==='pending').length,rounds:db.rounds.length,stake:String(stake),payout:String(payout),margin:String(stake-payout),currency:'DEMO_COIN',sample:true,asOf:now()};}
   else if(p==='/api/admin/deep/summary')result={games:{total:db.games.length,active:db.games.filter(x=>x.status==='Active').length},players:{total:db.players.length},tickets:{total:db.tickets.length,open:db.tickets.filter(x=>x.status!=='Closed').length},subscribers:db.subscribers.length,published:db.content.filter(x=>x.status==='published').length,integratedEngines:0};


   else if(p==='/api/admin/ops/notifications'){
    const items=db.adminActivity.map(x=>({...x,is_read:db.activityRead.includes(x.id)}));
    const limit=Math.max(1,Math.min(100,Number(u.searchParams.get('limit')||20)));
    result={items:items.slice(0,limit),unread:items.filter(x=>!x.is_read).length,
      scope:'browser_fixture',source:'synthetic_activity',externalDelivery:false,
      note:'Synthetic browser-only activity. No registration, real messages or external events.'};
   }
   else if(p==='/api/admin/ops/search'){
    const q=(u.searchParams.get('q')||'').trim().toLowerCase();
    if(q.length<2||q.length>80)error('Search query must contain 2 to 80 characters');
    const items=[];
    for(const g of db.games)if(g.name.toLowerCase().includes(q)||g.slug.toLowerCase().includes(q))
      items.push({type:'Game',label:g.name,route:'game/'+g.id,subtitle:'Sandbox game record'});
    for(const x of db.players)if(x.player_ref.toLowerCase().includes(q))
      items.push({type:'Player',label:x.player_ref,route:'player/'+x.id,subtitle:'Synthetic player'});
    for(const x of db.tickets)if(x.subject.toLowerCase().includes(q))
      items.push({type:'Ticket',label:x.subject,route:'ticket/'+x.id,subtitle:'Synthetic support ticket'});
    for(const x of db.content)if(x.title.toLowerCase().includes(q)||x.slug.toLowerCase().includes(q))
      items.push({type:'Content',label:x.title,route:'content-edit/'+x.kind+'/'+x.id,subtitle:'Synthetic content'});
    result={query:q,items:items.slice(0,24),source:'browser_fixtures',limit:24};
   }
   else if(p==='/api/admin/ops/profile'){
    result={item:{id:'sandbox-admin',username:'sandbox-demo',displayName:db.profile.displayName,role:'owner',status:'simulation',mfaEnabled:false},
      passwordChangeUrl:null,mfaUrl:null,avatarUploadAvailable:false};
   }
   else if(p==='/api/admin/ops/cron'){
    result={enabled:false,intervalMinutes:10,lastRun:db.cronRuns[0]||null,history:db.cronRuns,
      job:'synthetic_session_cleanup',externalVendorCron:false,remoteGameCron:false,
      note:'SIMULATION ONLY. Automatic scheduling and real expired sessions are not present.'};
   }
   else if(p==='/api/admin/parity'){
    const list=[['Dashboard','Dashboard','dashboard','partial'],['Manage Games','Games','games','partial'],
      ['Manage Games','Game Edit','games','partial'],['Manage Users','All Users','players/all','partial'],
      ['Manage Users','User Detail','players/all','partial'],['Manage Users','KYC Pending','players/kyc-pending','blocked'],
      ['Manage Users','Login as User','players/all','blocked'],['Manage Users','Virtual Balance','wallet/'+db.players[0].id,'partial'],
      ['Diamond Requests','All Diamond','diamonds/all','partial'],['Support Ticket','All Tickets','tickets/all','partial'],
      ['Report','Transfer History','report/transfers','partial'],['Subscribers','Subscribers','subscribers','partial'],
      ['System Setting','System Setting','settings','partial'],['Extra','Application','extra/application','partial'],
      ['Report & Request','Report & Request','report-request','partial']];
    const settingKeys=['general','logo','configuration','notification','seo','templates','pages','frontend','kyc','social','language','extensions','cron','policies','maintenance','gdpr','css','sitemap','robots'];
    const items=list.map(([group,name,route,status],i)=>({id:'sandbox-'+i,group,name,route,kind:'menu',status,notes:'Sandbox UI fixture only; not proof of a live integration.'}));
    settingKeys.forEach(key=>items.push({id:'setting-'+key,group:'System Setting',name:key,kind:'setting',route:'setting/'+key,status:key==='robots'?'implemented':'partial',notes:'Browser simulation; no backend service.'}));
    result={items,counts:{partial:items.filter(x=>x.status==='partial').length,blocked:items.filter(x=>x.status==='blocked').length,implemented:items.filter(x=>x.status==='implemented').length},
      service:{database:'simulated',adminAccounts:false,gameProfiles:false,virtualWallet:false,externalGameWallet:false,playerIdentityProvider:false,kycProvider:false,paymentProvider:false}};
   }
   else if(p==='/api/admin/virtual-ledger')result={items:db.walletOperations,currency:'DEMO_COIN'};
   else if((match=matches(/^\/api\/admin\/virtual-wallets\/([^/]+)$/,p))){
    const player=one(db.players,match[1]),wallet=one(db.wallets,player.id);
    result={player:{id:player.id,player_ref:player.player_ref,game_id:player.game_id},balance:wallet.balance,entries:wallet.entries,
      currency:'DEMO_COIN',externalWalletConnected:false,notice:'Browser fixture balance only; no server, game sync or money.'};
   }

   else if(['/api/admin/games','/api/admin/deep/games'].includes(p))result={items:db.games};
   else if((match=matches(/^\/api\/admin\/deep\/games\/([^/]+)\/rounds$/,p))){one(db.games,match[1]);result=roundPageFixtures(db.rounds.filter(x=>x.game_id===match[1]),u);}
   else if((match=matches(/^\/api\/admin\/deep\/games\/([^/]+)$/,p)))result={item:one(db.games,match[1])};
   else if(['/api/admin/players','/api/admin/deep/players'].includes(p)){const state=u.searchParams.get('state')||'all';result={items:db.players.filter(x=>state==='all'||x.local_status===state||state==='banned'&&x.local_status==='blocked_locally')};}
   else if((match=matches(/^\/api\/admin\/deep\/players\/([^/]+)\/rounds$/,p))){const x=one(db.players,match[1]);result=roundPageFixtures(db.rounds.filter(r=>r.game_id===x.game_id&&r.player_ref===x.player_ref),u);}
   else if((match=matches(/^\/api\/admin\/deep\/players\/([^/]+)$/,p)))result={item:one(db.players,match[1]),balanceEnabled:false,kycConnected:false,impersonationEnabled:false};
   else if(['/api/admin/rounds','/api/admin/deep/rounds'].includes(p))result={items:db.rounds};
   else if((match=matches(/^\/api\/admin\/deep\/rounds\/([^/]+)$/,p)))result={item:one(db.rounds,match[1]),immutable:true};
   else if(p==='/api/admin/requests')result={items:db.requests};
   else if((match=matches(/^\/api\/admin\/deep\/requests\/([^/]+)$/,p)))result={item:one(db.requests,match[1]),settlementEnabled:false};
   else if(p==='/api/admin/tickets')result={items:db.tickets};
   else if((match=matches(/^\/api\/admin\/deep\/tickets\/([^/]+)$/,p))){const t=one(db.tickets,match[1]);result={item:t,messages:t.messages||[],externalDelivery:false};}
   else if(p==='/api/admin/settings')result={items:db.settings};
   else if(p==='/api/admin/audit')result={items:db.audit};
   else if(p==='/api/admin/deep/subscribers')result={items:db.subscribers};
   else if((match=matches(/^\/api\/admin\/deep\/content\/([^/]+)(?:\/([^/]+))?$/,p)))result=match[2]?{item:one(db.content.filter(x=>x.kind===match[1]),match[2])}:{items:db.content.filter(x=>x.kind===match[1])};
   else if((match=matches(/^\/api\/admin\/deep\/reports\/([^/]+)$/,p))){
    const filter=u.searchParams.get('result')||'all';
    if(match[1]==='transactions'&&!['all','win','loss','draw'].includes(filter))error('Invalid result filter');
    const rounds=db.rounds.map(x=>({...x,result:Number(x.payout)>Number(x.stake)?'win':Number(x.payout)<Number(x.stake)?'loss':'draw'}));
    result={items:match[1]==='transactions'?rounds.filter(x=>filter==='all'||filter===x.result):
      match[1]==='notifications'?db.notifications:match[1]==='transfers'?db.walletOperations.filter(x=>x.action==='transfer'):[],
      notice:'BROWSER SIMULATION. No external round settlement or bank transactions.'};
   }
   else if(p==='/api/admin/system'||p.startsWith('/api/admin/deep/system/'))result={name:p.split('/').at(-1),appVersion:'sandbox-1.1.0',readOnly:true,dbConnected:false,mfaEnabled:false,rbacEnabled:false,gameControlConnected:false,asOf:now(),message:'Static development preview only. No real accounts or operational services.'};
   else error('This preview route is not simulated',501);
  }else if(m==='POST'&&p==='/api/admin/ops/notifications/read-all'){
   for(const x of db.adminActivity)if(!db.activityRead.includes(x.id))db.activityRead.push(x.id);
   result={ok:true,marked:db.activityRead.length};
  }else if(m==='POST'&&(match=matches(/^\/api\/admin\/ops\/notifications\/([0-9]+)\/read$/,p))){
   if(!db.adminActivity.some(x=>x.id===match[1]))error('Synthetic activity not found',404);
   if(!db.activityRead.includes(match[1]))db.activityRead.push(match[1]);
   result={ok:true,id:match[1]};
  }else if(m==='PUT'&&p==='/api/admin/ops/profile'){
   const name=String(b.displayName||'').trim();
   if(name.length<2||name.length>80||/[<>]/.test(name))error('Invalid display name');
   db.profile.displayName=name;
   result={ok:true,item:{username:'sandbox-demo',displayName:name,role:'owner',status:'simulation'}};
  }else if(m==='POST'&&p==='/api/admin/ops/cron/run'){
   const run={id:String(db.cronRuns.length+1),actor:'sandbox-demo',status:'completed',
     cleaned_revocations:0,cleaned_sessions:0,started_at:now(),finished_at:now()};
   db.cronRuns.unshift(run);db.cronRuns=db.cronRuns.slice(0,20);
   result={ok:true,status:'completed',run,manual:true,simulation:true};
  }else if(m==='POST'&&p==='/api/admin/games'){
   if(!b.name||!b.slug||!b.code)error('Name, slug and code are required');if(db.games.length>=30)error('Fixture capacity reached; reset demo');
   if(db.games.some(x=>x.slug===b.slug))error('Demo slug already exists',409);
   const item={...seed().games[0],id:uuid(),name:String(b.name).slice(0,100),slug:String(b.slug).slice(0,80),code:String(b.code).slice(0,12),platform:String(b.platform||'Simulation').slice(0,80),rounds:'0'};db.games.push(item);result={item};
  }else if(m==='PUT'&&(match=matches(/^\/api\/admin\/deep\/games\/([^/]+)$/,p))){
   const x=one(db.games,match[1]);if(Number(b.version)!==x.version)error('Fixture changed; reload',409);
   if(!b.name||[b.demo_chance,b.winning_chance,b.win_amount].some(n=>!Number.isInteger(n)||n<0||n>100)||b.min_invest>b.max_invest)error('Invalid demo configuration');
   for(const k of ['name','code','platform','demo_chance','winning_chance','win_amount','invest_enabled','min_invest','max_invest','trending','featured','instructions'])x[k]=b[k];x.version++;result={ok:true,version:x.version,externalEngineAffected:false};
  }else if(m==='POST'&&(match=matches(/^\/api\/admin\/deep\/games\/([^/]+)\/image$/,p))){const x=one(db.games,match[1]);if(!/^data:image\/(jpeg|png|webp);base64,/.test(b.data||''))error('Image required');x.image=b.data;x.has_image=true;result={ok:true};
  }else if(m==='PATCH'&&(match=matches(/^\/api\/admin\/games\/([^/]+)$/,p))){const x=one(db.games,match[1]);if(!['Active','Maintenance'].includes(b.status))error('Invalid fixture state');x.status=b.status;result={item:x};
  }else if(m==='PUT'&&(match=matches(/^\/api\/admin\/deep\/players\/([^/]+)$/,p))){const x=one(db.players,match[1]);if(Number(b.version)!==x.version)error('Fixture changed; reload',409);for(const k of ['first_name','last_name','city','state','zip','country','admin_note','local_status'])x[k]=String(b[k]||'').slice(0,1500);x.version++;result={ok:true,version:x.version};
  }else if(m==='PATCH'&&(match=matches(/^\/api\/admin\/requests\/([^/]+)$/,p))){const x=one(db.requests,match[1]);if(x.status!=='pending')error('Already reviewed',409);if(!['approved','rejected'].includes(b.status))error('Invalid decision');x.status=b.status;x.note=String(b.note||'').slice(0,500);x.reviewed_at=now();result={item:x,settled:false};
  }else if(m==='POST'&&p==='/api/admin/tickets'){if(!b.subject||!b.requester_ref)error('Subject and requester required');if(db.tickets.length>=50)error('Fixture capacity reached');const item={id:uuid(),subject:String(b.subject).slice(0,200),requester_ref:String(b.requester_ref).slice(0,120),priority:b.priority||'Medium',status:'Open',created_at:now(),messages:[]};db.tickets.push(item);result={item};
  }else if(m==='PATCH'&&(match=matches(/^\/api\/admin\/tickets\/([^/]+)$/,p))){const x=one(db.tickets,match[1]);if(!['Open','Pending','Answered','Closed'].includes(b.status))error('Invalid status');x.status=b.status;result={item:x};
  }else if(m==='POST'&&(match=matches(/^\/api\/admin\/deep\/tickets\/([^/]+)\/replies$/,p))){const x=one(db.tickets,match[1]);if(!b.body)error('Message required');if(x.messages.length>=50)error('Fixture capacity reached');const item={id:uuid(),author:'sandbox-demo',body:String(b.body).slice(0,4000),created_at:now()};x.messages.push(item);result={item,sentExternally:false};
  }else if(m==='PUT'&&(match=matches(/^\/api\/admin\/settings\/([^/]+)$/,p))){if(!b.value||typeof b.value!=='object'||JSON.stringify(b.value).length>16000)error('Invalid fixture setting');let x=db.settings.find(x=>x.key===match[1]);if(!x){x={key:match[1],version:0};db.settings.push(x);}x.value=b.value;x.version++;x.updated_at=now();result={item:x};

  }else if(m==='POST'&&(match=matches(/^\/api\/admin\/virtual-wallets\/([^/]+)\/(adjust|transfer)$/,p))){
   const player=one(db.players,match[1]),w=one(db.wallets,player.id),amount=Number(b.amount);
   if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000||!b.note||String(b.note).trim().length<5||!b.idempotency_key)error('Use a positive amount, reason and request ID');
   const previous=db.walletOperations.find(x=>x.idempotency_key===b.idempotency_key);
   if(previous){if(previous.amount!==String(amount)||previous.source!==player.id||previous.action!==(match[2]==='transfer'?'transfer':'admin_'+b.action))error('Idempotency conflict',409);result={ok:true,replay:true,operationId:previous.id};}
   else{
    const transfer=match[2]==='transfer',action=transfer?'transfer':'admin_'+b.action;
    if(!transfer&&!['credit','debit'].includes(b.action))error('Credit/debit action required');
    const target=transfer?one(db.players,b.to_player_id):null;
    if(transfer&&(target.id===player.id||target.game_id!==player.game_id))error('Choose another player from the same game');
    const amountSigned=(transfer||b.action==='debit')?-amount:amount;
    if(Number(w.balance)+amountSigned<0)error('Insufficient virtual fixture balance',409);
    const targetWallet=target?one(db.wallets,target.id):null;
    if(targetWallet&&Number(targetWallet.balance)+amount>1000000000000)error('Recipient limit',409);
    const op={id:uuid(),idempotency_key:b.idempotency_key,action,source:player.id,target:target?.id||null,
      amount:String(amount),actor:'sandbox-demo',note:String(b.note).trim(),created_at:now(),currency:'DEMO_COIN'};
    db.walletOperations.unshift(op);
    w.balance=String(Number(w.balance)+amountSigned);
    w.entries.unshift({id:uuid(),delta:String(amountSigned),balance_after:w.balance,action,actor:'sandbox-demo',note:op.note,created_at:op.created_at});
    if(targetWallet){targetWallet.balance=String(Number(targetWallet.balance)+amount);targetWallet.entries.unshift({id:uuid(),delta:String(amount),balance_after:targetWallet.balance,action:'transfer',actor:'sandbox-demo',note:op.note,created_at:op.created_at});}
    result={ok:true,operationId:op.id,balance:w.balance,currency:'DEMO_COIN',simulation:true};
   }
  }else if(m==='POST'&&p==='/api/admin/deep/notifications'){if(!b.title||!b.recipient_ref||!b.body)error('Fill notification fields');const item={id:uuid(),recipient_ref:String(b.recipient_ref).slice(0,120),title:String(b.title).slice(0,180),body:String(b.body).slice(0,2000),channel:'browser-only',status:'simulation-not-sent',created_at:now()};db.notifications.unshift(item);db.notifications=db.notifications.slice(0,50);result={item,sent:false};
  }else if(m==='POST'&&p==='/api/admin/deep/subscribers'){if(!b.contact||!String(b.contact).includes('@'))error('Use a synthetic email address');if(db.subscribers.length>=50)error('Fixture capacity reached');const item={id:uuid(),contact:String(b.contact).slice(0,200),status:'subscribed',created_at:now()};db.subscribers.push(item);result={item};
  }else if(m==='PATCH'&&(match=matches(/^\/api\/admin\/deep\/subscribers\/([^/]+)$/,p))){const x=one(db.subscribers,match[1]);if(!['subscribed','unsubscribed'].includes(b.status))error('Invalid status');x.status=b.status;result={item:x};
  }else if(['POST','PUT'].includes(m)&&(match=matches(/^\/api\/admin\/deep\/content\/([^/]+)(?:\/([^/]+))?$/,p))){
   if(!['page','policy','template','frontend'].includes(match[1])||!b.title||!b.slug||!['draft','published'].includes(b.status))error('Invalid fixture content');
   if(JSON.stringify(b).length>25000)error('Fixture too large');
   let x;if(m==='POST'){if(db.content.length>=50)error('Fixture capacity reached');x={id:uuid(),kind:match[1],version:0,created_at:now()};db.content.push(x);}else{x=one(db.content,match[2]);if(Number(b.version)!==x.version)error('Version conflict',409);}
   for(const k of ['slug','title','body','status'])x[k]=String(b[k]||'');x.version++;x.updated_at=now();result={item:x,publishedExternally:false};
  }else error('This operation is not available in the simulator',501);
  if(m!=='GET'){log(m+' '+p);save();}
  return response(result);
 }catch(e){return response({error:e.message},e.status||400);}
};
document.addEventListener('DOMContentLoaded',()=>{document.getElementById('sandbox-reset').addEventListener('click',()=>{sessionStorage.removeItem(KEY);location.replace('/');});});
})();
