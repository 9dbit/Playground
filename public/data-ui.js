'use strict';
(()=>{
const $=x=>document.querySelector(x),E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let role='viewer',run=0;
function dec(value){const raw=String(value??'0');if(!/^-?\d+(\.\d+)?$/.test(raw))return raw;const [a,b='']=raw.split('.'),fraction=b.replace(/0+$/,'');return a.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');}
function state(){const p=new URLSearchParams(location.search);return {environment:p.get('environment')||'production',game:p.get('game')||'all',tab:p.get('tab')||'dashboard',id:p.get('id'),before:p.get('before'),player:p.get('player'),result:p.get('result')||'all',q:p.get('q')||''};}
function href(patch){const p=new URLSearchParams(location.search);for(const [k,v]of Object.entries(patch))v==null?p.delete(k):p.set(k,v);return '/data?'+p;}
function route(tab,patch={}){return href({tab,id:null,before:null,player:null,q:null,result:null,...patch});}
function link(text,url){return '<a href="'+E(url)+'">'+E(text)+'</a>';}
function date(x){return x?new Date(x).toLocaleString():'Never';}
function badge(x){return '<span class="badge '+(['matched','prefix_matched'].includes(x)?'good':x==='mismatch'?'bad':'')+'">'+E(x)+'</span>';}
function table(headers,rows){return '<div class="table-wrap"><table><thead><tr>'+headers.map(x=>'<th>'+E(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.map(row=>'<tr>'+row.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+headers.length+'" class="empty">No records in this environment and game scope.</td></tr>')+'</tbody></table></div>';}
function cards(values){return '<div class="cards">'+values.map(([name,value])=>'<div class="card"><small>'+E(name)+'</small><strong>'+E(dec(value))+'</strong></div>').join('')+'</div>';}
async function api(path){const r=await fetch('/api/admin/data/'+path,{credentials:'same-origin',cache:'no-store'});if(r.status===401){location.replace('/login');throw Error('Login required');}const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
function query(s,extra={}){const p=new URLSearchParams({environment:s.environment,game:s.game,...extra});return '?'+p;}
async function render(){const seq=++run,s=state();$('#scope select[name=environment]').value=s.environment;$('#scope select[name=game]').value=s.game;
 $('#notice').className='notice'+(s.environment==='staging'?' stage':'');
 $('#notice').textContent=s.environment==='staging'?'STAGING / PILOT DATA. Test rounds stay in this scope and do not contribute to production totals. No actual-money value.':'PRODUCTION DATA ONLY. Staging and legacy records are excluded. An online heartbeat does not guarantee that all source rounds were delivered.';
 document.querySelectorAll('#tabs [data-tab]').forEach(a=>{a.href=route(a.dataset.tab);a.classList.toggle('active',a.dataset.tab===s.tab)});
 $('#players-tab').hidden=role==='viewer';$('#content').innerHTML='<div class="panel">Reading verified local records...</div>';
 try{let html='';
 if(s.tab==='dashboard'){
  const d=await api('summary'+query(s));
  html=cards([['Observed rounds',d.rounds],['Observed players',d.players],['Observed stake / DEMO_COIN',d.stake],['Credited effective payout / DEMO_COIN',d.payout]])+
   '<section class="panel"><h2>Game summary</h2>'+table(['Game','Environment','Rounds','Players','Stake','Payout','Last received'],d.games.map(x=>[link(x.name,route('rounds',{game:x.slug})),badge(x.environment),E(x.rounds),E(x.players),E(dec(x.stake)),E(dec(x.payout)),E(date(x.last_received_at))]))+'</section>'+
   '<section class="panel"><h2>Data boundaries</h2><p class="subtle">'+E(d.note)+'</p><p>Legacy records excluded: <b>'+E(d.legacy.records)+'</b>. Legacy amounts are not copied or silently added to these totals.</p><p>Latest receipt: '+E(date(d.last_received_at))+'</p>'+link('Review source reconciliation',route('reconciliation'))+'</section>';
 }else if(s.tab==='rounds'&&s.id){
  const d=await api('rounds/'+encodeURIComponent(s.id)+query(s)),x=d.item;
  html=link('Back to Game Log',route('rounds'))+'<section class="panel"><h2>Observed round '+E(x.source_round_id)+'</h2>'+table(['Field','Value'],Object.entries(x).map(([k,v])=>[E(k),k==='player_id'?link(v,route('player',{id:v})): '<div class="wrap">'+E(v)+'</div>']))+'<p class="subtle">Immutable observation. No edit, replay-payout or override action exists here.</p></section>';
 }else if(s.tab==='rounds'){
  const extra={result:s.result,q:s.q,limit:'25'};if(s.before)extra.before=s.before;if(s.player)extra.player=s.player;
  const d=await api('rounds'+query(s,extra));
  html='<form id="filter" class="controls"><input name="q" maxlength="80" value="'+E(s.q)+'" placeholder="Search round / event ID" aria-label="Search rounds"><select name="result"><option value="all">All net results</option><option value="win">Net win</option><option value="loss">Net loss</option><option value="draw">Draw</option></select><button type="submit">Filter</button></form><section class="panel"><h2>Game Log / '+E(s.environment)+'</h2>'+table(['Round','Game','Player','Stake','Payout','Net result','Time'],d.items.map(x=>[link(x.source_round_id,route('rounds',{id:x.id})),E(x.game),x.player_id?link(x.player_ref.slice(0,14)+'...',route('player',{id:x.player_id})):'Restricted',E(dec(x.stake)),E(dec(x.payout)),badge(x.result),E(date(x.occurred_at))]))+'<div class="controls">'+(s.before?link('First page',href({before:null})):'')+(d.next_cursor?link('Next page',href({before:d.next_cursor})):'')+'</div></section>';
 }else if(s.tab==='players'){
  const d=await api('players'+query(s));html='<section class="panel"><h2>Observed Players / '+E(s.environment)+'</h2><p class="subtle">'+E(d.note)+'</p>'+table(['Player reference','Game','Rounds','Stake','Payout','Last seen'],d.items.map(x=>[link(x.player_ref.slice(0,18)+'...',route('player',{id:x.id})),E(x.game),E(x.rounds),E(dec(x.stake)),E(dec(x.payout)),E(date(x.last_seen))]))+'</section>';
 }else if(s.tab==='player'&&s.id){
  const d=await api('players/'+encodeURIComponent(s.id)+query(s)),x=d.item;
  html=link('Back to observed players',route('players'))+'<section class="panel"><h2>Observed Player Detail</h2><p class="wrap">'+E(x.player_ref)+'</p><p>'+E(x.game)+' / '+E(x.environment)+'</p><p class="subtle">No verified email, phone, KYC, external balance or impersonation session. This is a stable pseudonymous game-side reference.</p></section>'+cards([['Rounds',x.rounds],['Stake',x.stake],['Credited effective payout',x.payout],['Player net return',x.net_return]])+link('View this player\'s observed rounds',route('rounds',{player:x.id}))+(s.environment==='staging'&&x.slug==='uno-luck'?' · '+link('Source wallet / transaction history (if connected)','/wallet?tab=players&id='+encodeURIComponent(x.id)):'');
 }else if(s.tab==='reconciliation'){
  const d=await api('reconciliations'+query(s));html='<section class="panel"><h2>Source-to-receiver reconciliation</h2><p class="subtle">'+E(d.note)+'</p>'+table(['Game','Scope','Verification','Through sequence','Source count','Received count','Source stake','Received stake','Source payout','Received payout','Checked'],d.items.map(x=>[E(x.game),badge(x.environment),badge(x.verification_state),E(x.through_sequence),E(x.expected_count),E(x.received_count),E(dec(x.expected_stake)),E(dec(x.received_stake)),E(dec(x.expected_payout)),E(dec(x.received_payout)),E(date(x.checked_at))]))+'<p class="subtle">A matched prefix proves source count, totals and ordered event manifest at the displayed watermark. Later events or a stale snapshot require a new check.</p></section>';
 }else html='<section class="panel">Unknown view. '+link('Open data dashboard',route('dashboard'))+'</section>';
 if(seq!==run)return;$('#content').innerHTML=html;
 const form=$('#filter');if(form){form.elements.result.value=s.result;form.onsubmit=e=>{e.preventDefault();location.href=href({q:form.elements.q.value.trim(),result:form.elements.result.value,before:null})};}
 }catch(e){if(seq===run)$('#content').innerHTML='<section class="panel error">'+E(e.message)+'</section>'}
}
$('#scope').onsubmit=e=>{e.preventDefault();const f=e.target;location.href='/data?'+new URLSearchParams({environment:f.elements.environment.value,game:f.elements.game.value,tab:'dashboard'})};$('#refresh').onclick=render;
(async()=>{const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});if(!r.ok){location.replace('/login');return}role=(await r.json()).role;await render()})().catch(e=>{$('#content').textContent=e.message});
})();
