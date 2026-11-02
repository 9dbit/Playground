'use strict';
(() => {
 const $=s=>document.querySelector(s),labels={online:'Online heartbeat',not_configured:'Not configured',awaiting_heartbeat:'Awaiting heartbeat',stale:'Heartbeat stale',degraded:'Server degraded'};
 let selected=null,cursor=null,loading=false;
 const elem=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
 const date=v=>v?new Date(v).toLocaleString():'Not received';
 // Do not convert telemetry decimals through Number, even only for display.
 const amount=v=>typeof v==='string'?v.replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1'):'';
 async function get(path){const r=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json'}});if(r.status===401){location.replace('/login');throw Error('Login required');}if(!r.ok)throw Error('Request failed ('+r.status+')');return r.json();}
 function metrics(d){$('#metrics').replaceChildren();for(const [title,value] of [['Configured game identities',d.configured],['Recent signed heartbeats',d.online],['Sources with accepted rounds',d.round_sources]]){const box=elem('div',undefined,'metric');box.append(elem('span',title),elem('strong',value));$('#metrics').append(box);}}
 function card(g){const c=elem('article',undefined,'card');c.dataset.game=g.slug;c.append(elem('h2',g.name),elem('span',labels[g.transport_state]||'Unknown', 'badge '+g.transport_state));
   const dl=elem('dl');for(const [title,value] of [['Environment',g.environments.join(', ')||'Unconfigured'],['Last signed heartbeat',date(g.last_heartbeat_at)],['Reported build',g.version||'Not received'],['Active key IDs',g.key_ids.join(', ')||'None'],['Accepted round observations',g.accepted_rounds||'0']]){dl.append(elem('dt',title),elem('dd',value));}c.append(dl);
   const gate=elem('div',undefined,'gate');gate.append(elem('strong',g.rounds_enabled?'Round ingestion permitted':'Round ingestion disabled'),elem('div',g.round_data_verified?'Accepted server observations exist.':'No round data has been verified.'),elem('div','Game control: disabled / Wallet: disconnected'));c.append(gate);
   const b=elem('button','View round observations');b.type='button';b.addEventListener('click',()=>openRounds(g));c.append(b);return c;
 }
 async function refresh(){if(loading)return;loading=true;$('#refresh').disabled=true;try{const d=await get('/api/admin/bridge');metrics(d);$('#games').replaceChildren(...d.items.map(card));$('#status').textContent=d.note;$('#updated').textContent='Server snapshot: '+date(d.as_of)+' / refreshes every 30 seconds';}catch(e){$('#status').textContent=e.message;}finally{loading=false;$('#refresh').disabled=false;}}
 async function openRounds(g,older=false){selected=g;$('#observations').hidden=false;$('#observations-title').textContent=g.name+' / Round observations';$('#rows').replaceChildren();$('#older').hidden=true;
   try{const d=await get('/api/admin/bridge/'+encodeURIComponent(g.slug)+'/rounds'+(older&&cursor?'?before='+encodeURIComponent(cursor):''));cursor=d.next_cursor;
    if(!d.items.length){const row=elem('tr'),cell=elem('td','No verified round observations. A heartbeat does not create gameplay records.','empty');cell.colSpan=5;row.append(cell);$('#rows').append(row);}
    for(const r of d.items){const row=elem('tr');for(const value of [r.source_round_id,r.environment,amount(r.stake),amount(r.payout),date(r.occurred_at)])row.append(elem('td',value));$('#rows').append(row);}
    $('#older').hidden=!cursor;
   }catch(e){$('#status').textContent=e.message;}
 }
 $('#refresh').addEventListener('click',refresh);$('#close').addEventListener('click',()=>{$('#observations').hidden=true;selected=null;cursor=null;});$('#older').addEventListener('click',()=>selected&&openRounds(selected,true));
 (async()=>{try{const session=await get('/api/auth/session');if(session.setupRequired){location.replace('/security');return;}await refresh();setInterval(()=>{if(!document.hidden)refresh();},30000);}catch(e){$('#status').textContent=e.message;}})();
})();
