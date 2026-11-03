'use strict';
(()=>{
const $=x=>document.querySelector(x),E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let role='viewer',csrf='',run=0;
function dec(value){const raw=String(value??'0');if(!/^-?\d+(\.\d+)?$/.test(raw))return raw;const [a,b='']=raw.split('.'),fraction=b.replace(/0+$/,'');return a.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');}
function state(){const p=new URLSearchParams(location.search);return {environment:p.get('environment')||'production',game:p.get('game')||'all',tab:p.get('tab')||'dashboard',id:p.get('id'),before:p.get('before'),player:p.get('player'),result:p.get('result')||'all',q:p.get('q')||'',observed:p.get('observed')};}
function href(patch){const p=new URLSearchParams(location.search);for(const [k,v]of Object.entries(patch))v==null?p.delete(k):p.set(k,v);return '/data?'+p;}
function route(tab,patch={}){return href({tab,id:null,before:null,player:null,q:null,result:null,observed:null,...patch});}
function link(text,url){return '<a href="'+E(url)+'">'+E(text)+'</a>';}
function date(x){return x?new Date(x).toLocaleString():'Never';}
function badge(x){return '<span class="badge '+(['matched','prefix_matched'].includes(x)?'good':x==='mismatch'?'bad':'')+'">'+E(x)+'</span>';}
function table(headers,rows){return '<div class="table-wrap"><table><thead><tr>'+headers.map(x=>'<th>'+E(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.map(row=>'<tr>'+row.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+headers.length+'" class="empty">No records in this environment and game scope.</td></tr>')+'</tbody></table></div>';}
function cards(values){return '<div class="cards">'+values.map(([name,value])=>'<div class="card"><small>'+E(name)+'</small><strong>'+E(dec(value))+'</strong></div>').join('')+'</div>';}
async function api(path){const r=await fetch('/api/admin/data/'+path,{credentials:'same-origin',cache:'no-store'});if(r.status===401){location.replace('/login');throw Error('Login required');}const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;}
function query(s,extra={}){const p=new URLSearchParams({environment:s.environment,game:s.game,...extra});return '?'+p;}
async function walletApi(path,s,method='GET',body){
 const opts={method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','X-CSRF-Token':csrf}};
 if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body)}
 const r=await fetch('/api/admin/source-wallet/'+path+query(s),opts),d=await r.json();
 if(r.status===401){location.replace('/login');throw Error('Login required')}
 if(!r.ok)throw Error(d.error||'Source wallet request failed');return d;
}
function walletForm(x){
 if(!['owner','support'].includes(role))return '<p class="subtle">This role can inspect source data but cannot submit balance requests.</p>';
 if(x.environment!=='staging')return '<p class="subtle">Balance commands are restricted to the isolated staging pilot.</p>';
 return '<form id="wallet-request" data-player="'+E(x.id)+'" data-key="'+crypto.randomUUID()+'" class="wallet-form">'+
 '<h3>Request source credit or debit</h3><p class="subtle">No balance changes on submit. An owner must approve; the game must confirm application. Credits have no cash value.</p>'+
 '<div class="controls"><label>Action<select name="action"><option value="credit">Credit</option><option value="debit">Debit</option></select></label>'+
 '<label>Virtual credits<input name="amount" inputmode="numeric" pattern="[1-9][0-9]{0,6}" required value="25" aria-label="Requested virtual credits"></label></div>'+
 '<label>Reason<textarea name="reason" minlength="5" maxlength="500" required placeholder="Explain the requested adjustment"></textarea></label>'+
 '<button type="submit">Submit for owner approval</button><p class="error" id="wallet-form-error" role="alert"></p></form>';
}
async function walletView(s){
 if(s.tab==='wallets'){
  const extra=s.observed?'players?observed='+encodeURIComponent(s.observed):'players';
  // Keep scope query explicit even when using the observed-player cross-link.
  const path='players'+query(s,s.observed?{observed:s.observed}:{});
  const r=await fetch('/api/admin/source-wallet/'+path,{credentials:'same-origin',cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.error||'Wallet records unavailable');
  return '<section class="panel"><h2>Source Wallets / '+E(s.environment)+'</h2><p class="subtle">'+E(d.note)+'</p>'+
   table(['Player','Game','Source balance','Revision','Verification','Snapshot time','Commands'],d.items.map(x=>[
    link(x.player_ref.slice(0,18)+'...',route('wallet',{id:x.id})),E(x.game),E(dec(x.balance)),E(x.revision),badge(x.verification),E(date(x.source_checked_at)),x.commands_available?'Owner review required':'Not available']))+'</section>';
 }
 if(s.tab==='wallet'&&s.id){
  let path='players/'+encodeURIComponent(s.id);const p=new URLSearchParams({environment:s.environment,game:s.game});if(s.before)p.set('before',s.before);
  const r=await fetch('/api/admin/source-wallet/'+path+'?'+p,{credentials:'same-origin',cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'Wallet not found');const x=d.item;
  return link('Back to source wallets',route('wallets'))+'<section class="panel"><h2>Source Player & Wallet Detail</h2><p class="wrap">'+E(x.player_ref)+'</p><p>'+E(x.game)+' / '+E(x.environment)+' / '+badge(x.verification)+'</p><p class="subtle">'+E(d.note)+'</p><p class="subtle">Coverage starts '+E(date(x.coverage_started_at))+'. Opening snapshots are observations, not fabricated transaction history. No verified email, phone or KYC is claimed.</p></section>'+
   cards([['Last observed source balance',x.balance],['Source ledger revision',x.revision],['Reconciled source sequence',x.through_sequence],['Received sequence',x.received_through]])+
   '<section class="panel"><h2>Balance freshness and authority</h2><p>Authority: <b>UNO game server</b>. Currency: DEMO_COIN. No withdrawals or monetary value.</p><p>Latest source observation: '+E(date(x.source_observed_at))+'. Last reconciliation: '+E(date(x.source_checked_at))+'.</p><p>Commands: '+(x.commands_available?'Available after explicit owner review':'Not currently available; check configuration, freshness and reconciliation')+'</p>'+
   (d.observed_player_id?link('View this player\'s observed rounds',route('rounds',{player:d.observed_player_id})): '<p class="subtle">No completed rounds linked yet.</p>')+'</section>'+
   '<section class="panel"><h2>Source balance history</h2>'+table(['Source seq.','Player revision','Reason','Change','Balance after','Observed at'],d.entries.map(e=>[E(e.source_sequence),E(e.player_sequence),E(e.kind),E(dec(e.delta)),E(dec(e.balance_after)),E(date(e.occurred_at))]))+
   '<div class="controls">'+(s.before?link('First ledger page',href({before:null})):'')+(d.next_cursor?link('Next ledger page',href({before:d.next_cursor})):'')+'</div></section>'+
   '<section class="panel">'+walletForm(x)+'</section>';
 }
 if(s.tab==='wallet-requests'&&!s.id){
  const d=await walletApi('requests',s);
  return '<section class="panel"><h2>Diamond Requests / Source Wallet</h2><p class="subtle">Pending review, queued and awaiting source confirmation are not successful credits. This workflow is separate from legacy local-only requests.</p>'+
  table(['Request','Player','Action','Amount','Requested by','Review','Source application','Created'],d.items.map(x=>[
   link(x.id.slice(0,8),route('wallet-requests',{id:x.id})),link(x.player_ref.slice(0,14)+'...',route('wallet',{id:x.source_player_id})),E(x.action),E(dec(x.amount)),E(x.requested_by),badge(x.review_status),badge(x.state),E(date(x.created_at))]))+'</section>';
 }
 if(s.tab==='wallet-requests'&&s.id){
  const d=await walletApi('requests/'+encodeURIComponent(s.id),s),x=d.item;
  return link('Back to Diamond Requests',route('wallet-requests'))+'<section class="panel"><h2>Source balance request</h2><p class="subtle">'+E(d.note)+'</p>'+table(['Field','Value'],[
   ['Request ID',E(x.id)],['Player',link(x.player_ref,route('wallet',{id:x.source_player_id}))],['Scope',E(x.game+' / '+x.environment)],['Action',E(x.action)],['Amount',E(dec(x.amount))],['Reason','<div class="wrap">'+E(x.reason)+'</div>'],['Requested by',E(x.requested_by)],['Review',badge(x.review_status)],['Application',badge(x.state)],['Reviewed by',E(x.reviewed_by||'Not reviewed')],['Command attempts',E(x.delivery_attempts??'Not dispatched')],['Expected source revision',E(x.expected_revision||'Not approved')],['Source result',E(x.result?.reason||x.result?.status||'No source confirmation')],['Finished',E(date(x.finished_at))]])+'</section>'+
   (x.review_status==='pending'&&role==='owner'?'<form id="wallet-review" class="panel wallet-form" data-id="'+E(x.id)+'" data-version="'+E(x.version)+'"><h3>Owner decision</h3><p class="subtle">Approval queues a command against the current reconciled source revision. It does not directly edit any game or local wallet balance.</p><label>Decision<select name="decision"><option value="approve">Approve and queue</option><option value="reject">Reject without dispatch</option></select></label><label>Review note<textarea name="note" required minlength="5" maxlength="500"></textarea></label><button type="submit">Confirm review</button><p class="error" id="wallet-form-error" role="alert"></p></form>':'')+
   (['queued','awaiting_source_confirmation'].includes(x.state)?'<section class="panel"><p class="subtle">Waiting for a signed application result and its matching source ledger entry. No automatic success is inferred from timeouts. Use Refresh to check.</p><button type="button" data-refresh-wallet>Refresh request status</button></section>':'');
 }
 return '<section class="panel">Unknown source wallet view.</section>';
}
function wireWalletForms(s){
 const form=$('#wallet-request');if(form)form.onsubmit=async e=>{
  e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;
  try{const d=await walletApi('requests',s,'POST',{player_id:form.dataset.player,action:form.elements.action.value,amount:form.elements.amount.value.trim(),reason:form.elements.reason.value.trim(),idempotency_key:form.dataset.key});location.href=route('wallet-requests',{id:d.id});}
  catch(error){$('#wallet-form-error').textContent=error.message;button.disabled=false;}
 };
 const review=$('#wallet-review');if(review)review.onsubmit=async e=>{
  e.preventDefault();const decision=review.elements.decision.value;
  if(!confirm(decision==='approve'?'Queue this virtual credit/debit command for the isolated source game? The balance changes only if the game accepts it.':'Reject this request without changing the source balance?'))return;
  const button=review.querySelector('button[type=submit]');button.disabled=true;
  try{await walletApi('requests/'+review.dataset.id+'/review',s,'POST',{decision,note:review.elements.note.value.trim(),version:Number(review.dataset.version)});await render();}
  catch(error){$('#wallet-form-error').textContent=error.message;button.disabled=false;}
 };
 document.querySelector('[data-refresh-wallet]')?.addEventListener('click',render);
}

async function render(){const seq=++run,s=state();$('#scope select[name=environment]').value=s.environment;$('#scope select[name=game]').value=s.game;
 $('#notice').className='notice'+(s.environment==='staging'?' stage':'');
 $('#notice').textContent=s.environment==='staging'?'STAGING / PILOT DATA. Test rounds stay in this scope and do not contribute to production totals. No actual-money value.':'PRODUCTION DATA ONLY. Staging and legacy records are excluded. An online heartbeat does not guarantee that all source rounds were delivered.';
 document.querySelectorAll('#tabs [data-tab]').forEach(a=>{a.href=route(a.dataset.tab);a.classList.toggle('active',a.dataset.tab===s.tab)});
 $('#players-tab').hidden=role==='viewer';$('#wallets-tab').hidden=role==='viewer';$('#requests-tab').hidden=role==='viewer';$('#content').innerHTML='<div class="panel">Reading verified local records...</div>';
 try{let html='';
 if(['wallets','wallet','wallet-requests'].includes(s.tab)){html=await walletView(s);}
 else if(s.tab==='dashboard'){
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
  html=link('Back to observed players',route('players'))+'<section class="panel"><h2>Observed Player Detail</h2><p class="wrap">'+E(x.player_ref)+'</p><p>'+E(x.game)+' / '+E(x.environment)+'</p><p class="subtle">No verified email, phone, KYC, external balance or impersonation session. This is a stable pseudonymous game-side reference.</p></section>'+cards([['Rounds',x.rounds],['Stake',x.stake],['Credited effective payout',x.payout],['Player net return',x.net_return]])+link('View this player\'s observed rounds',route('rounds',{player:x.id}))+'<div class="controls">'+link('Open source wallet and balance history',route('wallets',{observed:x.id}))+'</div>';
 }else if(s.tab==='reconciliation'){
  const d=await api('reconciliations'+query(s));html='<section class="panel"><h2>Source-to-receiver reconciliation</h2><p class="subtle">'+E(d.note)+'</p>'+table(['Game','Scope','Verification','Through sequence','Source count','Received count','Source stake','Received stake','Source payout','Received payout','Checked'],d.items.map(x=>[E(x.game),badge(x.environment),badge(x.verification_state),E(x.through_sequence),E(x.expected_count),E(x.received_count),E(dec(x.expected_stake)),E(dec(x.received_stake)),E(dec(x.expected_payout)),E(dec(x.received_payout)),E(date(x.checked_at))]))+'<p class="subtle">A matched prefix proves source count, totals and ordered event manifest at the displayed watermark. Later events or a stale snapshot require a new check.</p></section>';
 }else html='<section class="panel">Unknown view. '+link('Open data dashboard',route('dashboard'))+'</section>';
 if(seq!==run)return;$('#content').innerHTML=html;wireWalletForms(s);
 const form=$('#filter');if(form){form.elements.result.value=s.result;form.onsubmit=e=>{e.preventDefault();location.href=href({q:form.elements.q.value.trim(),result:form.elements.result.value,before:null})};}
 }catch(e){if(seq===run)$('#content').innerHTML='<section class="panel error">'+E(e.message)+'</section>'}
}
$('#scope').onsubmit=e=>{e.preventDefault();const f=e.target;location.href='/data?'+new URLSearchParams({environment:f.elements.environment.value,game:f.elements.game.value,tab:'dashboard'})};$('#refresh').onclick=render;
(async()=>{const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});if(!r.ok){location.replace('/login');return}const session=await r.json();role=session.role;csrf=session.csrf;await render()})().catch(e=>{$('#content').textContent=e.message});
})();
