(()=>{'use strict';
const $=s=>document.querySelector(s);
const E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=x=>x?new Date(x).toLocaleString('en-GB',{hour12:false}):'—';
const n=x=>new Intl.NumberFormat('en-US').format(Number(x||0));
const apiBase='/api/admin/';
const sidebar=[
 ['Dashboard','dashboard',[]],
 ['Manage Games','games',[['games','Games'],['rounds','Game Log']]],
 ['Manage Users','users',[['players/active','Active Users'],['players/banned','Banned Users'],['players/email','Email Unverified'],['players/mobile','Mobile Unverified'],['players/kyc','KYC Unverified'],['players/kyc-pending','KYC Pending'],['players/all','All Users'],['notify','Send Notification']]],
 ['Diamond Requests','diamonds',[['diamonds/pending','Pending Diamond'],['diamonds/approved','Approved Diamond'],['diamonds/rejected','Rejected Diamond'],['diamonds/all','All Diamond']]],
 ['Support Ticket','tickets',[['tickets/pending','Pending Ticket'],['tickets/closed','Closed Ticket'],['tickets/answered','Answered Ticket'],['tickets/all','All Ticket']]],
 ['Report','report',[['report/transactions','Transaction History'],['report/logins','Login History'],['report/notifications','Notification History'],['report/transfers','Transfer History']]],
 ['Subscribers','subscribers',[]],
 ['System Setting','settings',[]],
 ['Extra','extra',[['extra/application','Application'],['extra/server','Server'],['extra/cache','Cache'],['extra/update','Update']]],
 ['Report & Request','report-request',[]]
];
const settingItems=[
 ['general','General Setting','Site identity, theme and virtual unit formatting','⚙'],
 ['logo','Logo and Favicon','Brand assets and external URLs','◈'],
 ['configuration','System Configuration','Enabled platform features','▣'],
 ['notification','Notification Setting','Internal notification preferences','♧'],
 ['seo','SEO Configuration','Metadata drafts','◎'],
 ['templates','Manage Templates','Content drafts and publishing','▧'],
 ['pages','Manage Pages','Public informational pages','▤'],
 ['frontend','Manage Frontend','Site content slots and drafts','▥'],
 ['kyc','KYC Setting','Verification configuration only','♧'],
 ['social','Social Login Setting','Provider setup planning','◉'],
 ['language','Language','Locale planning','文'],
 ['extensions','Extensions','External integrations','✣'],
 ['cron','Cron Job Setting','Job monitoring (not scheduled)','◷'],
 ['policies','Policy Pages','Editable public policy documents','♜'],
 ['maintenance','Maintenance Mode','Controls public informational pages','⚒'],
 ['gdpr','GDPR Cookie','Consent policy planning','◌'],
 ['css','Custom CSS','Stored only; injection disabled','▦'],
 ['sitemap','Sitemap XML','Generated /sitemap.xml','♧'],
 ['robots','Robots txt','Public robots.txt rules','☷']
];
const settingFields={
 general:[['Site Title','site_title','text','Playground'],['Currency','currency','text','Demo Coin'],['Currency Symbol','currency_symbol','text','◈'],['Timezone','timezone','select','Asia/Jakarta','Asia/Jakarta|UTC|Asia/Singapore'],['Site Base Color','base_color','color','#4939f5'],['Site Secondary Color','secondary_color','color','#e2d273'],['Records Per Page','per_page','select','100','20|50|100'],['Currency Format','currency_format','select','symbol','symbol|text|both'],['Register Bonus (configuration only)','register_bonus','number','0'],['User Demo Balance (configuration only)','demo_balance','number','0'],['Fixed Transfer Charge (inactive)','transfer_fixed','number','0'],['Percentage Transfer Charge (inactive)','transfer_percent','number','0'],['Gameplay Bonus Frequency (inactive)','gameplay_bonus_count','number','0'],['Gameplay Bonus (inactive)','gameplay_bonus','number','0']],
 logo:[['Logo URL','logo_url','text',''],['Favicon URL','favicon_url','text','']],
 configuration:[['Platform Name','name','text','Playground'],['Read-only Mode','read_only','checkbox',false],['Game Bridge Enabled (not connected)','bridge_enabled','checkbox',false]],
 notification:[['In-app Notification Records','in_app_enabled','checkbox',true],['Email Delivery (not connected)','email_enabled','checkbox',false],['Sender Label','sender','text','Playground']],
 seo:[['Meta Title','meta_title','text','Playground'],['Meta Description','meta_description','textarea',''],['Keywords','keywords','text','']],
 kyc:[['KYC Enabled (config only)','kyc_enabled','checkbox',false],['Retention Days','retention_days','number','30']],
 social:[['Google OAuth Enabled (not connected)','google','checkbox',false],['Apple OAuth Enabled (not connected)','apple','checkbox',false]],
 language:[['Default Locale','default_locale','select','en','en|id'],['Supported Locales','supported','text','en,id']],
 extensions:[['Plugin Registry URL','registry_url','text',''],['Allow Extensions (not connected)','enabled','checkbox',false]],
 cron:[['Intended Schedule','schedule','text','0 0 * * *'],['Task Description','description','text','Not scheduled']],
 maintenance:[['Public Maintenance Enabled','enabled','checkbox',false],['Visitor Message','message','textarea','Maintenance in progress']],
 gdpr:[['Cookie Notice Text','notice','textarea',''],['Require Consent (not connected)','required','checkbox',false]],
 css:[['Custom CSS (stored, never executed)','draft','textarea','']],
 sitemap:[['Sitemap Generation','enabled','checkbox',true],['Public XML Endpoint','endpoint','text','/sitemap.xml']],
 robots:[['Robots.txt Content','rules','textarea','User-agent: *\nDisallow: /engine\nDisallow: /api/\nDisallow: /login\n']]
};
const flags={general:'Partial runtime styling',logo:'Stored only',configuration:'Stored only',notification:'Stored only',seo:'Stored only',kyc:'No verification provider',social:'No OAuth connected',language:'Stored only',extensions:'No extension runner',cron:'No scheduler',maintenance:'Public content enforcement',gdpr:'No consent service',css:'Execution disabled',sitemap:'Live generated endpoint',robots:'Live public endpoint'};
let token='',route='',renderSequence=0,expanded=new Set(['Manage Games','Manage Users']),mobile=false,settingCache=null,searchTerm='';
let queuedImage=null;
function go(r){const next='#/'+r;if(location.hash===next){render()}else location.hash=next;mobile=false}
function getRoute(){return decodeURIComponent((location.hash||'#/dashboard').replace(/^#\/?/,''))||'dashboard'}
function nav(){return '<aside class="sidebar '+(mobile?'mobile-open':'')+'"><div class="brand">◈ PLAY<span>GROUND</span><small>CONTROL</small></div>'+
 sidebar.map(([title,target,children])=>'<div class="nav-group"><button class="nav-root '+(route===target?'active':'')+'" data-root="'+E(title)+'" '+(children.length?'':'data-go="'+E(target)+'"')+'><span>◈</span>'+E(title)+(children.length?'<span class="arrow">'+(expanded.has(title)?'⌃':'⌄')+'</span>':'')+'</button>'+
 (children.length&&expanded.has(title)?'<div class="nav-children">'+children.map(([r,label])=>'<button class="nav-child '+(route===r?'active':'')+'" data-go="'+E(r)+'">'+E(label)+'</button>').join('')+'</div>':'')+'</div>').join('')+
 '<div class="nav-footer">Playground · Engine v0.7<br>Source: Checkpoint 06 audit</div></aside>'}
function shell(content){return '<div class="layout">'+nav()+'<section class="content-wrap"><header class="topbar"><div class="top-left"><button class="icon-btn navmobile" data-action="mobile">☰</button><button class="search" data-action="search">⌕ Search menus <kbd>Ctrl + K</kbd></button></div><div class="top-actions"><button class="icon-btn desktop" data-go="notify" title="Notification history">♧</button><button class="icon-btn desktop" data-go="extra/server" title="System information">⚙</button><button class="icon-btn" data-action="refresh">⟳</button><button class="icon-btn" data-action="logout">admin ▾</button></div></header><main class="main">'+content+'<footer class="footer">Playground Control Center · Data backed by PostgreSQL unless marked otherwise · No external game control or wallet settlement</footer></main></section></div>'}
function heading(title,subtitle='',back='',extra=''){return '<div class="head"><div><div class="crumb">PLAYGROUND / '+E(route.replaceAll('/',' / '))+'</div><h1>'+E(title)+'</h1><p>'+E(subtitle)+'</p></div><div class="actions">'+(back?'<button class="btn ghost" data-go="'+E(back)+'">← Back</button>':'')+extra+'</div></div>'}
function notice(s,kind=''){return '<div class="notice '+kind+'">'+E(s)+'</div>'}
function badge(s){const a=String(s||'');return '<span class="pill '+(/active|approved|published|verified|open|true|subscribed/i.test(a)?'good':/failed|rejected|banned|blocked/i.test(a)?'danger':'warning')+'">'+E(a)+'</span>'}
function table(headers,rows){return '<div class="panel"><div class="table-scroller"><table class="table"><thead><tr>'+headers.map(x=>'<th>'+E(x)+'</th>').join('')+'</tr></thead><tbody>'+((rows||[]).length?rows.map(x=>'<tr>'+x.map(y=>'<td>'+y+'</td>').join('')+'</tr>').join(''):'<tr><td class="empty" colspan="'+headers.length+'">No matching records. Empty data is not replaced with demo numbers.</td></tr>')+'</tbody></table></div></div>'}
function link(title,path){return '<button class="link" data-go="'+E(path)+'">'+E(title)+'</button>'}
function metric(title,value,icon,path){return '<div class="stat"><div class="symbol">'+icon+'</div><small>'+E(title)+'</small><strong>'+E(value)+'</strong>'+(path?'<div class="cardlinks"><button class="link" data-go="'+E(path)+'">View All →</button></div>':'')+'</div>'}
function field(name,key,type,value,options){let input;
 if(type==='textarea')input='<textarea name="'+E(key)+'" rows="5">'+E(value)+'</textarea>';
 else if(type==='checkbox')input='<input type="checkbox" name="'+E(key)+'" '+(value===true||value==='true'?'checked':'')+'>';
 else if(type==='select')input='<select name="'+E(key)+'">'+String(options||'').split('|').map(x=>'<option value="'+E(x)+'" '+(String(value)===x?'selected':'')+'>'+E(x)+'</option>').join('')+'</select>';
 else input='<input name="'+E(key)+'" type="'+E(type)+'" value="'+E(value)+'" '+(type==='number'?'min="0" step="any"':'')+'>';
 return '<label class="field '+(type==='textarea'?'tall':'')+'">'+E(name)+input+'</label>'}
function formFields(f){return '<div class="field-grid">'+f.map(x=>field(...x)).join('')+'</div>'}
function formValues(form){const values=Object.fromEntries(new FormData(form));form.querySelectorAll('[type=checkbox]').forEach(x=>values[x.name]=x.checked);form.querySelectorAll('[type=number]').forEach(x=>values[x.name]=Number(values[x.name]||0));if('version' in values)values.version=Number.parseInt(values.version,10);return values}
async function api(path,method='GET',body){const headers={'Accept':'application/json','X-CSRF-Token':token};const opts={method,credentials:'same-origin',headers};if(body!==undefined){headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}
 const r=await fetch(path,opts);if(r.status===401){location.replace('/login');throw Error('Login required')}
 const data=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok)throw Error(data.error||'Request failed');return data}
function toast(message){document.querySelector('.toast')?.remove();const x=document.createElement('div');x.className='toast';x.textContent=message;document.body.appendChild(x);setTimeout(()=>x.remove(),4200)}
async function dashboard(){const [d,s,g]=await Promise.all([api(apiBase+'deep/summary'),api(apiBase+'summary'),api(apiBase+'deep/games')]);
 const v=[metric('Games',d.games.total,'◈','games'),metric('Active Catalog Entries',d.games.active,'◉','games'),metric('Observed Players',d.players.total,'♙','players/all'),metric('Settled Rounds',s.rounds,'▧','rounds'),metric('Total Played · Demo Coin',n(s.stake),'◈','report/transactions'),metric('Total Win · Demo Coin',n(s.payout),'◇','report/transactions'),metric('Support Tickets',d.tickets.total,'▤','tickets/all'),metric('Subscribers',d.subscribers,'♧','subscribers')];
 return heading('Dashboard','Overview from persistent database. Integrations are not yet connected.')+
 notice('Zero integration adapters: Skygate 5000, UNO LUCK and Mahjong Wild are catalog entries only. No live game controls or cash balances.')+
 '<div class="stats">'+v.join('')+'</div><div class="panel"><h2>Game Registry</h2></div>'+
 table(['Game','Build','State','Sessions','Open'],g.items.map(x=>[link(x.name,'game/'+x.id),E(x.version),badge(x.status),E(x.rounds),link('Configure →','game/'+x.id)]));
}
async function games(){const q=await api(apiBase+'deep/games');
 return heading('Manage Games','Catalog, demo-only configuration, artwork and game log','','<button class="btn" data-action="game-create">+ Add Game</button>')+
 notice('Game status here is catalog metadata; it does not remotely pause or configure the separate game engines.')+
 table(['Name','Status','Featured','Trending','Rounds','Action'],q.items.map(x=>[link(x.name,'game/'+x.id),badge(x.status),badge(x.featured),badge(x.trending),E(x.rounds),link('Edit / Details →','game/'+x.id)]));
}
async function game(id){const data=await api(apiBase+'deep/games/'+id);const g=data.item;
 return heading('Update '+g.name,'Game Details · settings are versioned · no live outcome modification','games',link('View Game Log','game-rounds/'+g.id))+
 notice('Demo chance and investment options are sandbox configuration only. Live odds, payouts and settled rounds cannot be overridden here.','warn')+
 '<form class="game-editor" id="game-edit" data-id="'+E(id)+'"><input type="hidden" name="version" value="'+E(g.version)+'"><div class="grid"><section class="panel"><h2>Game Identity</h2>'+
 formFields([['Game Name','name','text',g.name],['Short Code','code','text',g.code],['Platform','platform','text',g.platform]])+
 '<div class="image-preview">'+(g.has_image?'<img src="'+apiBase+'deep/games/'+E(id)+'/image?at='+Date.now()+'" alt="Game artwork">':'No artwork uploaded')+'</div><label class="field">Artwork (PNG/JPEG/WebP, max 500KB after compression)<input id="game-image" type="file" accept="image/png,image/jpeg,image/webp"></label></section>'+
 '<section class="panel"><h2>Game Demo Settings</h2>'+formFields([['Demo Winning Chance (%)','demo_chance','number',g.demo_chance],['Minimum Demo Invest','min_invest','number',g.min_invest],['Maximum Demo Invest','max_invest','number',g.max_invest],['Invest / Give Back','invest_enabled','checkbox',g.invest_enabled],['Trending','trending','checkbox',g.trending],['Featured','featured','checkbox',g.featured]])+'</section></div>'+
 '<section class="panel"><h2>Game Instructions</h2>'+formFields([['Instructions (safe plain text; rich text editor planned)','instructions','textarea',g.instructions]])+
 '<div class="form-actions"><button class="btn" type="submit">Save Configuration</button></div></section></form>';
}
async function gameRounds(id){const [g,rr]=await Promise.all([api(apiBase+'deep/games/'+id),api(apiBase+'deep/games/'+id+'/rounds')]);
 return heading('Game Log · '+g.item.name,'Immutable events received from the signed game endpoint','game/'+id)+
 table(['Event','Round','Player','Stake','Payout','Occurred'],rr.items.map(x=>[E(x.event_id),link(x.round_id,'round/'+x.id),E(x.player_ref),n(x.stake),n(x.payout),fmt(x.occurred_at)]));
}
async function roundList(playerId){const q=playerId?await api(apiBase+'deep/players/'+playerId+'/rounds'):await api(apiBase+'deep/rounds');
 return heading(playerId?'Player Rounds':'Game Log','Read-only signed event history',playerId?'player/'+playerId:'games')+
 table(['Round','Game','Player','Stake','Payout','Date'],q.items.map(x=>[link(x.round_id,x.id?'round/'+x.id:'rounds'),E(x.game||''),E(x.player_ref||''),n(x.stake),n(x.payout),fmt(x.occurred_at)]));
}
async function round(id){const d=await api(apiBase+'deep/rounds/'+id);const x=d.item;
 return heading('Round '+x.round_id,'Immutable settled round detail','rounds')+notice('Evidence only. Editing, re-settlement and reversal are not supported.')+
 table(['Field','Value'],Object.entries(x).map(([k,v])=>[E(k),E(v)]));
}
async function players(state){if(['email','mobile','kyc','kyc-pending'].includes(state))return heading('Manage Users · '+state,'Verification provider is not integrated yet','players/all')+notice('No identity verification dataset exists; this view cannot claim verified/unverified accounts.', 'warn')+table(['Status'],[]);
 const q=await api(apiBase+'deep/players?state='+encodeURIComponent(state||'all'));
 return heading('Manage Users · '+(state||'all'),'Pseudonymous players from signed game events')+
 notice('User Details do not include email, phone or identification records. Local status has no enforcement at the external game engine.')+
 table(['Player','Game','Rounds','Local Status','Last Seen','Detail'],q.items.map(x=>[link(x.player_ref,'player/'+x.id),E(x.game),n(x.rounds),badge(x.local_status),fmt(x.last_seen),link('Details →','player/'+x.id)]));
}
async function player(id){const d=await api(apiBase+'deep/players/'+id),p=d.item;
 const fields=[['First Name','first_name','text',p.first_name],['Last Name','last_name','text',p.last_name],['City','city','text',p.city],['State','state','text',p.state],['ZIP/Postal','zip','text',p.zip],['Country','country','text',p.country],['Local Status (not enforced in game)','local_status','select',p.local_status,'active|review|blocked_locally'],['Admin Note','admin_note','textarea',p.admin_note]];
 return heading('User Detail · '+p.player_ref,'Pseudonymous player · '+p.game,'players/all')+
 '<div class="stats">'+metric('Balance','Not enabled','◇')+metric('Total Played',n(p.total_played),'◈','player-rounds/'+p.id)+metric('Total Win',n(p.total_win),'◆','player-rounds/'+p.id)+metric('Net Return',n(p.net_return),'◎','player-rounds/'+p.id)+'</div>'+
 '<div class="toolbar"><button class="btn ghost" disabled title="Wallet integration required">+ Balance</button><button class="btn ghost" disabled>- Balance</button><button class="btn ghost" data-go="report/logins">Logins</button><button class="btn ghost" data-go="report/notifications">Notifications</button><button class="btn ghost" disabled>Login as User (disabled)</button></div>'+
 notice('KYC, Email/Mobile verification, 2FA and wallet are not connected. Any local status changes affect only this admin database.','warn')+
 '<form class="panel" id="player-edit" data-id="'+E(id)+'"><h2>Profile Metadata</h2><input type="hidden" name="version" value="'+E(p.version)+'">'+formFields(fields)+
 '<div class="form-actions"><button class="btn" type="submit">Save Metadata</button></div></form>';
}
async function diamonds(state){const q=await api(apiBase+'requests');const filtered=q.items.filter(x=>state==='all'||x.status===state);
 return heading('Diamond Requests · '+state,'Review virtual-currency requests without settlement')+notice('Approval changes the review record only. It never credits balances.','warn')+
 table(['Reference','Player','Amount','State','Created','Detail'],filtered.map(x=>[link(x.id.slice(0,8),'request/'+x.id),E(x.player_ref),n(x.amount),badge(x.status),fmt(x.created_at),link('View →','request/'+x.id)]));
}
async function request(id){const d=await api(apiBase+'deep/requests/'+id),x=d.item;
 return heading('Diamond Request · '+id.slice(0,8),'Review state · settlement disabled','diamonds/all')+
 notice('Decision here does not create funds, make payouts, or contact a payment provider.', 'warn')+
 table(['Field','Value'],[['Player',E(x.player_ref)],['Amount',n(x.amount)],['Status',badge(x.status)],['Created',fmt(x.created_at)],['Reviewed',fmt(x.reviewed_at)],['Note',E(x.note)]])+
 (x.status==='pending'?'<div class="toolbar"><button class="btn green" data-action="request-decision" data-id="'+E(id)+'" data-value="approved">Approve metadata</button><button class="btn warn" data-action="request-decision" data-id="'+E(id)+'" data-value="rejected">Reject</button></div>':'');
}
async function tickets(state){const q=await api(apiBase+'tickets');const list=q.items.filter(x=>state==='all'||(state==='pending'&&['Open','Pending'].includes(x.status))||(state==='closed'&&x.status==='Closed')||(state==='answered'&&x.status==='Answered'));
 return heading('Support Tickets · '+state,'Internal ticket records and threaded replies','','<button class="btn" data-action="ticket-create">+ New Ticket</button>')+
 table(['Subject','Requester','Priority','Status','Created','Detail'],list.map(x=>[link(x.subject,'ticket/'+x.id),E(x.requester_ref),badge(x.priority),badge(x.status),fmt(x.created_at),link('Open →','ticket/'+x.id)]));
}
async function ticket(id){const d=await api(apiBase+'deep/tickets/'+id),x=d.item;
 return heading('Ticket · '+x.subject,'Internal thread. No outbound email or customer delivery.','tickets/all')+
 '<div class="panel"><div class="status-line">Requester: '+E(x.requester_ref)+' · Priority: '+badge(x.priority)+' · Status: '+badge(x.status)+'</div>'+
 '<div class="toolbar" style="margin-top:14px"><button class="btn ghost" data-action="ticket-state" data-id="'+E(id)+'" data-value="Open">Open</button><button class="btn ghost" data-action="ticket-state" data-id="'+E(id)+'" data-value="Answered">Answered</button><button class="btn ghost" data-action="ticket-state" data-id="'+E(id)+'" data-value="Closed">Close</button></div></div>'+
 '<div class="panel"><h2>Conversation</h2>'+(d.messages.length?d.messages.map(m=>'<div class="step" style="margin-bottom:9px"><b>'+E(m.author)+'</b><small class="muted"> · '+fmt(m.created_at)+'</small><p style="white-space:pre-wrap">'+E(m.body)+'</p></div>').join(''):'<div class="empty">No replies yet</div>')+'</div>'+
 '<form id="ticket-reply" data-id="'+E(id)+'" class="panel"><h2>Record Reply</h2>'+formFields([['Message (saved internally, not sent)','body','textarea','']])+'<div class="form-actions"><button class="btn">Add Reply</button></div></form>';
}
async function report(kind){const q=await api(apiBase+'deep/reports/'+kind);const keys=kind==='transactions'?['event_id','round_id','game','stake','payout','currency','occurred_at']:kind==='logins'?['username','success','ip','created_at']:kind==='notifications'?['recipient_ref','title','channel','status','created_at']:['source','target','amount'];
 return heading(kind==='transactions'?'Transaction History':kind==='logins'?'Login History':kind==='notifications'?'Notification History':'Transfer History','Reports, drill-down and export')+
 notice(q.notice,kind==='transfers'?'warn':'')+
 '<div class="toolbar"><button class="btn ghost" data-action="export">Download visible CSV</button></div>'+
 table(keys.map(x=>x.replaceAll('_',' ')),q.items.map(x=>keys.map(k=>k==='round_id'?link(x[k],'round/'+x.id):E(x[k]))));
}
async function subscribers(){const q=await api(apiBase+'deep/subscribers');
 return heading('Subscribers','Local subscriber registry, no email marketing provider connected','','<button class="btn" data-action="subscriber-create">+ Add Subscriber</button>')+
 table(['Contact','Status','Created','Action'],q.items.map(x=>[E(x.contact),badge(x.status),fmt(x.created_at),'<button class="link" data-action="subscriber-state" data-id="'+E(x.id)+'" data-value="'+(x.status==='subscribed'?'unsubscribed':'subscribed')+'">'+(x.status==='subscribed'?'Unsubscribe':'Resubscribe')+'</button>']));
}
async function notify(){const q=await api(apiBase+'deep/reports/notifications');
 return heading('Send Notification','Internal records only, delivery providers disconnected')+notice('Notifications are written to audit history, not delivered to players or email addresses.', 'warn')+
 '<form class="panel" id="notification-create"><h2>Record Internal Notification</h2>'+formFields([['Recipient Reference','recipient_ref','text','admin'],['Title','title','text',''],['Message','body','textarea','']])+
 '<div class="form-actions"><button class="btn">Record Notification</button></div></form>'+
 table(['Recipient','Title','Channel','State','Time'],q.items.map(x=>[E(x.recipient_ref),E(x.title),E(x.channel),badge(x.status),fmt(x.created_at)]));
}
async function settingsHub(){return heading('System Settings','19 modules based on the verified settings hub')+
 '<div class="toolbar"><input class="qsearch" id="settings-filter" placeholder="Search settings..." value="'+E(searchTerm)+'"></div><div class="grid3" id="settings-grid">'+settingItems.filter(x=>x[1].toLowerCase().includes(searchTerm.toLowerCase())).map(([key,label,desc,icon])=>'<button class="settings-item" data-go="'+(key==='pages'?'content/page':key==='policies'?'content/policy':key==='templates'?'content/template':key==='frontend'?'content/frontend': 'setting/'+key)+'"><span class="tileicon">'+icon+'</span><span><b>'+E(label)+'</b><small>'+E(desc)+'</small></span></button>').join('')+'</div>';
}
async function setting(key){const schema=settingFields[key];
 if(!schema)return heading('Setting unavailable','No dedicated form yet','settings')+notice('Module not connected');
 const q=await api(apiBase+'settings'),record=q.items.find(x=>x.key===key),v=record?.value||{};
 const fields=schema.map(([name,k,type,def,opts])=>[name,k,type,v[k]??def,opts]);
 return heading(settingItems.find(x=>x[0]===key)?.[1]||key,'Saved in PostgreSQL and audited · '+(flags[key]||'Stored only'),'settings')+
 notice((key==='robots'?'This is published at /robots.txt. ':key==='maintenance'?'Maintenance applies to published information pages only. ':key==='general'?'Title and brand color apply to this admin UI after refresh. ':'This setting is stored for later provider integration; saving does not activate unavailable services. ')+(flags[key]||''),key==='general'?'':'warn')+
 '<form id="setting-save" class="panel" data-key="'+E(key)+'"><h2>Configuration</h2>'+formFields(fields)+
 '<div class="form-actions"><button class="btn">Save '+E(key)+'</button></div></form>';
}
async function content(kind){const q=await api(apiBase+'deep/content/'+kind);
 return heading(kind.charAt(0).toUpperCase()+kind.slice(1)+' Management','Create, edit, version and publish content in PostgreSQL','settings','<button class="btn" data-go="content-edit/'+kind+'/new">+ Create</button>')+
 notice('Published page/policy content is available at /info/{slug}. Template and Frontend records are drafts until integrated with their consumers.')+
 table(['Title','Slug','Status','Version','Modified','Action'],q.items.map(x=>[link(x.title,'content-edit/'+kind+'/'+x.id),E(x.slug),badge(x.status),n(x.version),fmt(x.updated_at),link('Edit →','content-edit/'+kind+'/'+x.id)]));
}
async function contentEdit(kind,cid){const isNew=cid==='new',p=isNew?{title:'',slug:'',body:'',status:'draft',version:1}:(await api(apiBase+'deep/content/'+kind+'/'+cid)).item;
 return heading((isNew?'Create ':'Edit ')+kind,'Versioned content editor · safe plain-text publishing','content/'+kind)+
 '<form class="panel" id="content-edit" data-kind="'+E(kind)+'" data-id="'+E(cid)+'"><input type="hidden" name="version" value="'+E(p.version)+'">'+
 formFields([['Title','title','text',p.title],['Slug','slug','text',p.slug],['Status','status','select',p.status,'draft|published'],['Body (safe plain text)','body','textarea',p.body]])+
 '<div class="form-actions"><button class="btn">Save Content</button></div></form>';
}
async function extra(kind){const q=await api(apiBase+'deep/system/'+kind);
 return heading(kind==='security'?'Security':kind.charAt(0).toUpperCase()+kind.slice(1),'Read-only service inspection','dashboard')+
 notice(q.message,'warn')+
 table(['Property','Value'],Object.entries(q).map(([k,v])=>[E(k),E(v)]));
}
async function reportRequest(){return heading('Report & Request','Use support tickets for internal reporting and requests','tickets/all')+notice('External abuse-report workflow is not connected. Create an auditable support ticket instead.')+
 '<button class="btn" data-action="ticket-create">Create Internal Ticket</button>'}
async function show(){const parts=route.split('/'),a=parts[0],b=parts[1],c=parts[2];
 if(a==='dashboard')return dashboard();
 if(a==='games')return games();
 if(a==='game')return game(b);
 if(a==='game-rounds')return gameRounds(b);
 if(a==='rounds')return roundList();
 if(a==='round')return round(b);
 if(a==='players')return players(b||'all');
 if(a==='player')return player(b);
 if(a==='player-rounds')return roundList(b);
 if(a==='diamonds')return diamonds(b||'all');
 if(a==='request')return request(b);
 if(a==='tickets')return tickets(b||'all');
 if(a==='ticket')return ticket(b);
 if(a==='report')return report(b);
 if(a==='subscribers')return subscribers();
 if(a==='notify')return notify();
 if(a==='settings')return settingsHub();
 if(a==='setting')return setting(b);
 if(a==='content')return content(b);
 if(a==='content-edit')return contentEdit(b,c);
 if(a==='extra')return extra(b);
 if(a==='report-request')return reportRequest();
 return heading('Not found','This route has not been implemented','dashboard');
}
async function render(){route=getRoute();const current=++renderSequence;$('#app').innerHTML=shell('<div class="loading">Loading '+E(route)+'…</div>');
 try{const content=await show();if(current!==renderSequence)return;$('#app').innerHTML=shell(content);if(route==='settings')$('#settings-filter')?.addEventListener('input',e=>{searchTerm=e.target.value;const tiles=settingItems.filter(x=>x[1].toLowerCase().includes(searchTerm.toLowerCase()));$('#settings-grid').innerHTML=tiles.map(([key,label,desc,icon])=>'<button class="settings-item" data-go="'+(key==='pages'?'content/page':key==='policies'?'content/policy':key==='templates'?'content/template':key==='frontend'?'content/frontend':'setting/'+key)+'"><span class="tileicon">'+icon+'</span><span><b>'+E(label)+'</b><small>'+E(desc)+'</small></span></button>').join('')})}
 catch(e){if(current!==renderSequence)return;$('#app').innerHTML=shell(heading('Load failed',e.message,'dashboard')+notice('Endpoint may be unavailable. Use Refresh after checking Railway logs.','warn'));console.error(e)}}
function modal(title,fields,action){document.querySelector('.modal-screen')?.remove();const el=document.createElement('div');el.className='modal-screen';el.innerHTML='<div class="modal"><h2>'+E(title)+'</h2><form id="modal-form" data-kind="'+E(action)+'">'+formFields(fields)+'<div class="form-actions"><button type="button" class="btn ghost" data-action="close">Cancel</button><button class="btn">Save</button></div></form></div>';document.body.appendChild(el)}
function allRoutes(){return sidebar.flatMap(g=>[[g[1],g[0]],...g[2]]).concat(settingItems.map(x=>['setting/'+x[0],x[1]]))}
function search(){const el=document.createElement('div');el.className='modal-screen';el.innerHTML='<div class="global-search"><div class="toolbar"><input id="global-query" autofocus placeholder="Search page names..."><button class="btn ghost control-close" data-action="close">✕</button></div><div id="global-results"></div></div>';document.body.appendChild(el);const input=$('#global-query');input.focus();input.addEventListener('input',()=>{$('#global-results').innerHTML=allRoutes().filter(x=>x[1].toLowerCase().includes(input.value.toLowerCase())).slice(0,15).map(([r,t])=>'<button class="result" data-go="'+E(r)+'">'+E(t)+'</button>').join('')});input.dispatchEvent(new Event('input'))}
async function toImage(file){if(!file)return null;if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Only PNG/JPEG/WebP accepted');const bmp=await createImageBitmap(file);const canvas=document.createElement('canvas');let scale=Math.min(1,900/Math.max(bmp.width,bmp.height));canvas.width=Math.round(bmp.width*scale);canvas.height=Math.round(bmp.height*scale);canvas.getContext('2d').drawImage(bmp,0,0,canvas.width,canvas.height);let data=canvas.toDataURL('image/jpeg',.8);if(data.length>680000)data=canvas.toDataURL('image/jpeg',.55);if(data.length>680000)throw Error('Image too large after compression');return data}
document.addEventListener('click',async e=>{
 const goBtn=e.target.closest('[data-go]');if(goBtn){document.querySelector('.modal-screen')?.remove();go(goBtn.dataset.go);return}
 const navBtn=e.target.closest('[data-root]');if(navBtn&&sidebar.find(x=>x[0]===navBtn.dataset.root)?.[2]?.length){const label=navBtn.dataset.root;expanded.has(label)?expanded.delete(label):expanded.add(label);render();return}
 const btn=e.target.closest('[data-action]');if(!btn)return;
 const a=btn.dataset.action;
 try{
  if(a==='search')return search();
  if(a==='mobile'){mobile=!mobile;return render()}
  if(a==='close'){document.querySelector('.modal-screen')?.remove();return}
  if(a==='refresh')return render();
  if(a==='logout'){await api('/api/auth/logout','POST');location.replace('/login');return}
  if(a==='game-create')return modal('Add Game',[['Game Name','name','text',''],['Slug','slug','text',''],['Code','code','text',''],['Platform','platform','text','Web / PWA']],'game');
  if(a==='ticket-create')return modal('New Support Ticket',[['Subject','subject','text',''],['Requester Reference','requester_ref','text',''],['Priority','priority','select','Medium','Low|Medium|High']],'ticket');
  if(a==='subscriber-create')return modal('Register Subscriber',[['Email Address','contact','text','']],'subscriber');
  if(a==='request-decision'){const answer=prompt('Decision note (no balance change):','Reviewed by admin');if(answer===null)return;await api(apiBase+'requests/'+btn.dataset.id,'PATCH',{status:btn.dataset.value,note:answer});toast('Request metadata updated; no funds credited');return render()}
  if(a==='ticket-state'){await api(apiBase+'tickets/'+btn.dataset.id,'PATCH',{status:btn.dataset.value});toast('Ticket status saved');return render()}
  if(a==='subscriber-state'){await api(apiBase+'deep/subscribers/'+btn.dataset.id,'PATCH',{status:btn.dataset.value});toast('Subscriber updated');return render()}
  if(a==='export'){const rows=[...document.querySelectorAll('.table tr')].map(tr=>[...tr.children].map(td=>'"'+td.innerText.replaceAll('"','""')+'"').join(','));const blob=new Blob([rows.join('\n')],{type:'text/csv'}),url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='playground-'+route.replaceAll('/','-')+'.csv';link.click();URL.revokeObjectURL(url);return}
 }catch(err){toast('Error: '+err.message)}
});
document.addEventListener('submit',async e=>{
 const form=e.target;if(!['game-edit','player-edit','ticket-reply','setting-save','notification-create','content-edit','modal-form'].includes(form.id))return;
 e.preventDefault();
 try{
  const v=formValues(form);
  if(form.id==='game-edit'){const id=form.dataset.id;const r=await api(apiBase+'deep/games/'+id,'PUT',v);if(queuedImage){await api(apiBase+'deep/games/'+id+'/image','POST',{data:await toImage(queuedImage)});queuedImage=null}toast('Version '+r.version+' saved · live engine unchanged');return render()}
  if(form.id==='player-edit'){const r=await api(apiBase+'deep/players/'+form.dataset.id,'PUT',v);toast('Profile metadata saved · version '+r.version);return render()}
  if(form.id==='ticket-reply'){await api(apiBase+'deep/tickets/'+form.dataset.id+'/replies','POST',v);toast('Reply recorded internally');return render()}
  if(form.id==='setting-save'){await api(apiBase+'settings/'+form.dataset.key,'PUT',{value:v});toast('Settings saved');if(form.dataset.key==='general')applyTheme(v);return render()}
  if(form.id==='notification-create'){await api(apiBase+'deep/notifications','POST',v);toast('Recorded internally · not delivered');return render()}
  if(form.id==='content-edit'){const kind=form.dataset.kind,id=form.dataset.id;const uri=apiBase+'deep/content/'+kind+(id==='new'?'':'/'+id);await api(uri,id==='new'?'POST':'PUT',v);toast('Content saved');go('content/'+kind);return}
  if(form.id==='modal-form'){const kind=form.dataset.kind;
   if(kind==='game')await api(apiBase+'games','POST',v);
   if(kind==='ticket')await api(apiBase+'tickets','POST',v);
   if(kind==='subscriber')await api(apiBase+'deep/subscribers','POST',v);
   document.querySelector('.modal-screen')?.remove();toast('Record added');return render()}
 }catch(err){toast('Save error: '+err.message)}
});
document.addEventListener('change',e=>{if(e.target.id==='game-image'){queuedImage=e.target.files[0]||null;if(queuedImage){const p=$('.image-preview');if(p){p.innerHTML='';const img=document.createElement('img');img.src=URL.createObjectURL(queuedImage);p.appendChild(img)}}}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();search()}if(e.key==='Escape')document.querySelector('.modal-screen')?.remove()});
function applyTheme(v){if(/^#[0-9a-f]{6}$/i.test(String(v.base_color)))document.documentElement.style.setProperty('--brand',v.base_color);if(v.site_title)document.title=v.site_title+' · Playground Control'}
(async()=>{try{const s=await api('/api/auth/session');token=s.csrf;try{const d=await api(apiBase+'settings');const cfg=d.items.find(x=>x.key==='general');if(cfg)applyTheme(cfg.value)}catch{}window.addEventListener('hashchange',render);await render()}catch(err){console.error('Bootstrap failed',err)}})();
})();