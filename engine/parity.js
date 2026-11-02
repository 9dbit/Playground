'use strict';
const roots=[
['Dashboard','dashboard',[
 ['Dashboard overview','dashboard','partial','KPI cards are backed by PostgreSQL; reference login charts and true profit metrics still missing.']]],
['Manage Games','games',[
 ['Games','games','partial','Registry and editor save; remote game runtime settings not connected.'],
 ['Game Log','rounds','partial','Signed ingested rounds visible; all external round streams not yet enabled.'],
 ['Game Edit','games','partial','Name, artwork, demo chance, limits, trending, featured and instructions stored. Rich editor and other reference fields still missing.']]],
['Manage Users','players/all',[
 ['Active Users','players/active','partial','Activity derives from local records; external account status not verified.'],
 ['Banned Users','players/banned','partial','Local flag only, no external game enforcement.'],
 ['Email Unverified','players/email','blocked','Email provider and player identity source not connected.'],
 ['Mobile Unverified','players/mobile','blocked','Phone verification provider not connected.'],
 ['KYC Unverified','players/kyc','blocked','Identity verification and evidence source not connected.'],
 ['KYC Pending','players/kyc-pending','blocked','KYC applications workflow not connected.'],
 ['All Users','players/all','partial','Pseudonymous signed-event players only.'],
 ['Send Notification','notify','partial','Internal record only; SMS, email and push delivery not connected.'],
 ['User Detail','players/all','partial','Local profile, round summary, DEMO_COIN wallet; no verified PII, KYC or impersonation.']]],
['Diamond Requests','diamonds/all',[
 ['Pending Diamond','diamonds/pending','partial','Decision metadata only; no external settlement.'],
 ['Approved Diamond','diamonds/approved','partial','Administrative approval only, no wallet credit.'],
 ['Rejected Diamond','diamonds/rejected','partial','Reason and decision stored; notification not delivered.'],
 ['All Diamond','diamonds/all','partial','Request list and detail from database.']]],
['Support Ticket','tickets/all',[
 ['Pending Ticket','tickets/pending','partial','Internal ticket and status; customer delivery not integrated.'],
 ['Closed Ticket','tickets/closed','partial','Internal state and reply thread.'],
 ['Answered Ticket','tickets/answered','partial','Internal replies only, external delivery not implemented.'],
 ['All Ticket','tickets/all','partial','Create, detail, status and replies; attachments missing.']]],
['Report','report/transactions',[
 ['Transaction History','report/transactions','partial','Signed virtual round events, not banking transactions.'],
 ['Login History','report/logins','partial','Administrator login history only.'],
 ['Notification History','report/notifications','partial','In-app stored notification records only.'],
 ['Transfer History','report/transfers','partial','Internal virtual transfers; game wallets not synchronized.']]],
['Subscribers','subscribers',[
 ['Subscribers','subscribers','partial','Local add and status; email distribution not connected.']]],
['System Setting','settings',[
 ['System Setting','settings','partial','Nineteen cards render; many save JSON without runtime consumers.']]],
['Extra','extra/application',[
 ['Application','extra/application','partial','Read-only metadata.'],
 ['Server','extra/server','partial','Read-only status; no live infra controls.'],
 ['Cache','extra/cache','blocked','No verified cache invalidation engine.'],
 ['Update','extra/update','blocked','No safe automated-update workflow.']]],
['Report & Request','report-request',[
 ['Report & Request','report-request','partial','Creates internal support tickets; external report workflow not integrated.']]]
];
const settings=[
['General Setting','general','partial','Site title/theme partly reflected; bonus and transfer charge behaviors not integrated.'],
['Logo and Favicon','logo','partial','URL metadata stored, not applied to application assets.'],
['System Configuration','configuration','partial','JSON stored; only selected module settings consumed.'],
['Notification Setting','notification','partial','Preferences stored; no delivery pipeline.'],
['SEO Configuration','seo','partial','Metadata stored; not applied to every frontend page.'],
['Manage Templates','templates','partial','Versioned template content CRUD; no template renderer.'],
['Manage Pages','pages','partial','Versioned page content CRUD and public text.'],
['Manage Frontend','frontend','partial','Versioned content records; frontend slots not connected.'],
['KYC Setting','kyc','blocked','External identity verification workflow not integrated.'],
['Social Login Setting','social','blocked','OAuth provider integration not active.'],
['Language','language','partial','Locale settings stored; translations incomplete.'],
['Extensions','extensions','blocked','No extension sandbox or runtime.'],
['Cron Job Setting','cron','blocked','No configured, monitored job runner.'],
['Policy Pages','policies','partial','Published simple text page; rich editor and SEO incomplete.'],
['Maintenance Mode','maintenance','partial','Protects published info pages, not external game sites.'],
['GDPR Cookie','gdpr','blocked','Consent recording and revocation not connected.'],
['Custom CSS','css','partial','Stored only; unsafe arbitrary CSS injection deliberately disabled.'],
['Sitemap XML','sitemap','partial','Generated from published info pages; public storefront incomplete.'],
['Robots txt','robots','implemented','Served as text/plain with configured rules.']
];
const specials=[
['Dashboard','Global search','dashboard','partial','Navigation and database record search active; source game user records may be incomplete.'],
['Dashboard','Admin notifications','activity','partial','Per-admin read/unread is active for audited local events, not real member-registration messages.'],
['Dashboard','Login by browser, OS, country','dashboard','blocked','Game player login analytics not connected.'],
['Dashboard','Cron Setup and run manually','cron','partial','Run history and owner-only safe session cleanup; automatic execution requires explicit enabled setting.'],
['Dashboard','Profile and Password','profile','partial','Admin display name is editable and Security Center handles passwords; avatar upload not connected.'],
['Dashboard','Game Log Win/Loss Filters','report/transactions/win','partial','Derives net result from observed stake versus payout; not vendor win_status.'],
['Manage Games','Demo winning configuration','games','partial','Sandbox-only metadata; never alters a real settled round.'],
['Manage Users','Virtual Balance and Ledger','players/all','partial','Internal, audited DEMO_COIN balance only; no game wallet synchronization.'],
['Manage Users','Balance credit and debit','players/all','partial','Owner-only, idempotent DEMO_COIN adjustment with reason and audit.'],
['Manage Users','Balance transfer','players/all','partial','Same-game pseudonymous users only; no external credits or fees.'],
['Manage Users','Verification toggles','players/all','blocked','No attested email/phone/KYC provider; not allowed to falsely show Verified.'],
['Manage Users','Login as User','players/all','blocked','Impersonation disabled pending audited limited session design.'],
['Manage Users','User login history','report/logins','blocked','Only admin sign-ins observed; player login source not connected.'],
['Report','Virtual ledger history','virtual-ledger','partial','PostgreSQL operations; no banking ledger or settlements.'],
['System Setting','Register bonus processing','setting/general','blocked','Bonus values stored but no registration/ledger award trigger.'],
['System Setting','Transfer fee processing','setting/general','blocked','Transfer fee values stored but not posted to a fee account.'],
['Extra','Health and integration monitoring','extra/server','partial','Railway health and signed heartbeat, not full engine event stream.']
];
function inventory(){
 const items=[];
 for(const [group,base,entries] of roots){
  items.push({id:'group:'+group,group,name:group,route:base,kind:'root',status:'navigation',evidence:'screenshot-menu'});
  for(const [name,route,status,notes] of entries)items.push({id:group+':'+name,group,name,route,kind:'menu',status,notes,evidence:'source-implementation'});
 }
 for(const [name,key,status,notes] of settings){
  const route=['templates','pages','frontend','policies'].includes(key)?
   'content/'+({templates:'template',pages:'page',frontend:'frontend',policies:'policy'}[key]):'setting/'+key;
  items.push({id:'settings:'+key,group:'System Setting',name,route,kind:'setting',status,notes,evidence:'source-implementation'});
 }
 for(const [group,name,route,status,notes] of specials)
  items.push({id:'function:'+group+':'+name,group,name,route,kind:'function',status,notes,evidence:'source-implementation'});
 return items;
}
function mount(app,{pool}){
 app.get('/api/admin/parity',async(req,res,next)=>{
  try{
   const q=await pool.query("SELECT to_regclass('gameops_virtual_wallet_accounts') AS wallets,to_regclass('gameops_virtual_wallet_entries') AS wallet_entries,to_regclass('gameops_admin_accounts') AS admin_accounts,to_regclass('gameops_game_profiles') AS game_profiles,to_regclass('gameops_virtual_wallet_operations') AS wallet_operations");
   const schema=q.rows[0],items=inventory();
   const counts=items.reduce((all,x)=>(all[x.status]=(all[x.status]||0)+1,all),{});
   const service={database:'connected',adminAccounts:!!schema.admin_accounts,gameProfiles:!!schema.game_profiles,
    virtualWallet:!!schema.wallets&&!!schema.wallet_entries&&!!schema.wallet_operations,
    externalGameWallet:false,playerIdentityProvider:false,kycProvider:false,paymentProvider:false};
   res.json({version:'checkpoint-11',reference:'Xaxino v4.0 admin demo, screenshots and existing navigation inventory',
    verifiedVendorDeepLinks:5,assessment:'Source-backed capability inventory, not proof of end-to-end parity with all vendor pages',
    items,counts,service,asOf:new Date().toISOString()});
  }catch(e){next(e)}
 });
}
module.exports={inventory,mount};
