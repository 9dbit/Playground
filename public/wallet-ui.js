'use strict';
(()=>{
const $=x=>document.querySelector(x);
const E=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const q=new URLSearchParams(location.search),tab=q.get('tab')||'players',scope='?environment=staging&game=uno-luck';
const date=x=>x?new Date(x).toLocaleString():'Never';
const short=x=>String(x||'').slice(0,20)+'...';
const mark=x=>'<span class="badge '+(['matched','applied'].includes(x)?'good':['failed','rejected','stale'].includes(x)?'bad':'')+'">'+E(x)+'</span>';
const table=(head,rows)=>'<div class="table-wrap"><table><thead><tr>'+head.map(x=>'<th>'+E(x)+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.map(r=>'<tr>'+r.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+head.length+'" class="empty">No verified source records in the pilot yet.</td></tr>')+'</tbody></table></div>';
const box=(label,value)=>'<div class="card"><small>'+E(label)+'</small><strong>'+E(value)+'</strong></div>';
let session=null;
async function api(path,method='GET',body){
 const headers={...(method!=='GET'?{'Content-Type':'application/json','X-CSRF-Token':session.csrf}:{})};
 const r=await fetch('/api/admin/source-wallet/'+path+scope,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store'});
 if(r.status===401){location.assign('/login');throw Error('Login required')}
 const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed');return data;
}
function canEdit(x,allowed){return session.role==='owner'&&allowed&&x.reconciliation==='matched'&&x.commands_enabled&&!x.active_round&&Date.now()-Date.parse(x.last_seen)<90000}
function statusMessage(x){const age=x.last_seen?Math.max(0,Math.floor((Date.now()-Date.parse(x.last_seen))/1000))+'s ago':'never';return 'Source '+x.reconciliation+' · Last sync '+age+' · Account ledger version '+x.version}
async function render(){
 const selected=q.get('id'),body=$('#content');body.innerHTML='<section class="panel">Loading source-confirmed records...</section>';
 for(const a of document.querySelectorAll('#tabs a'))a.classList.toggle('active',a.dataset.tab===tab);
 try{
  const summary=await api('summary'),items=await api('players');
  let html='<div class="cards">'+box('Source players',summary.players)+box('Virtual source credits',summary.source_balance)+box('Matched ledgers',summary.matched)+box('Pending commands',summary.pending_commands)+'</div>';
  html+='<section class="panel"><h2>Connection status</h2><p class="subtle">Source of truth: '+E(summary.sourceOfTruth)+'. Admin credit/debit switch: <b>'+E(summary.commandsConfigured?'configured':'disabled')+'</b>. Pending credit requests: '+E(summary.pending_requests)+'. Wallet observations are not external financial settlements.</p></section>';
  if(tab==='requests'){
   const d=await api('requests');
   html+='<section class="panel"><h2>Diamond Requests / Virtual Credits</h2><p class="subtle">A player request does not create credits. Approval queues a source command; Applied requires matching journal proof.</p>'+table(['Received','Player','Amount','Reason','State','Decision'],d.items.map(x=>[E(date(x.created_at)),E(short(x.player_ref)),E(x.amount)+' DEMO_COIN','<div class="wrap">'+E(x.note)+'</div>',mark(x.state),x.state==='pending'&&session.role==='owner'?'<button type="button" data-review="'+E(x.id)+'" data-decision="approve">Approve</button> <button type="button" data-review="'+E(x.id)+'" data-decision="reject">Reject</button>':'<span class="subtle">'+E(x.reviewed_by||'Awaiting owner')+'</span>']))+'</section>';
  }else if(selected){
   const d=await api('players/'+encodeURIComponent(selected)),x=d.item;
   html+='<section class="panel"><a href="/wallet?tab=players">Back to players</a><h2>Source Balance / '+E(short(x.player_ref))+'</h2><p class="subtle">'+E(statusMessage(x))+'</p><p>Source account: <code>'+E(x.id)+'</code></p><p>Stream: <code>'+E(x.stream_id)+'</code></p>'+box('Confirmed virtual balance',x.balance+' DEMO_COIN')+'</section>';
   if(canEdit(x,d.commandsAllowed))html+='<section class="panel"><h2>Queue a source command</h2><p class="subtle">Only the UNO server can apply it. Maximum 10,000 virtual credits per request. Enter the audit reason.</p><form id="adjust" class="controls"><select name="action" aria-label="Operation"><option value="credit">Credit</option><option value="debit">Debit</option></select><input name="amount" type="number" min="1" max="10000" step="1" required placeholder="Virtual credits"><input name="reason" minlength="8" maxlength="300" required placeholder="Reason for audit"><button type="submit">Queue command</button></form></section>';
   else html+='<section class="panel"><h2>Source commands unavailable</h2><p class="subtle">Requires owner authentication, enabled staging gates, a matched fresh ledger and no active round. You may inspect historical entries safely.</p></section>';
   html+='<section class="panel"><h2>Source Transaction History</h2>'+table(['Version','Reason','Change','Before','After','Source time'],d.entries.map(y=>[E(y.version),E(y.reason),E(y.delta),E(y.balance_before),E(y.balance_after),E(date(y.occurred_at))]))+'</section>';
   html+='<section class="panel"><h2>Administrative Commands</h2>'+table(['Created','Action','Amount','Reason','Status','Source confirmation'],d.commands.map(y=>[E(date(y.created_at)),E(y.action),E(y.amount),'<div class="wrap">'+E(y.reason)+'</div>',mark(y.state),E(y.source_code||'Not received yet')]))+'</section>';
  }else{
   html+='<section class="panel"><h2>UNO Pilot Players</h2><p class="subtle">Balances are read from signed ledger snapshots, not calculated from rounds. Choose a player to inspect source entries.</p>'+table(['Player','Verified balance','Version','Status','Source time'],items.items.map(x=>['<a href="/wallet?tab=players&id='+encodeURIComponent(x.id)+'">'+E(short(x.player_ref))+'</a>',E(x.balance),E(x.version),mark(x.reconciliation),E(date(x.source_checked_at))]))+'</section>';
  }
  body.innerHTML=html;
  const adjust=$('#adjust');if(adjust)adjust.onsubmit=async e=>{
   e.preventDefault();const btn=adjust.querySelector('button');btn.disabled=true;
   try{
    const x=(await api('players/'+encodeURIComponent(selected))).item,form=new FormData(adjust);
    const result=await api('players/'+encodeURIComponent(selected)+'/commands','POST',{id:crypto.randomUUID(),action:form.get('action'),amount:String(form.get('amount')),expected_version:x.version,reason:String(form.get('reason'))});
    alert('Command '+result.item.id+' queued. No balance change is claimed until the source confirms it.');await render();
   }catch(err){alert(err.message);btn.disabled=false}
  };
  body.querySelectorAll('[data-review]').forEach(btn=>btn.onclick=async()=>{
   const decision=btn.dataset.decision,reason=prompt(decision==='approve'?'Reason for approving virtual credits':'Reason for rejecting request');
   if(!reason)return;
   btn.disabled=true;
   try{const d=await api('requests/'+btn.dataset.review+'/review','POST',{decision,reason,command_id:decision==='approve'?crypto.randomUUID():undefined});alert(d.item.state==='queued'?'Approved and queued, awaiting source proof.':'Request rejected.');await render();}
   catch(err){alert(err.message);btn.disabled=false}
  });
 }catch(e){body.innerHTML='<section class="panel error">'+E(e.message)+'</section>'}
}
$('#refresh').onclick=render;
(async()=>{const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});if(!r.ok){location.replace('/login');return}session=await r.json();await render()})().catch(e=>$('#content').textContent=e.message);
})();
