'use strict';
// Add a clear source boundary without relabeling legacy records as live data.
(()=>{
 let busy=false;
 const add=()=>{
  const sidebar=document.querySelector('.sidebar,.side');
  if(sidebar&&!sidebar.querySelector('[data-cp15-link], [data-go="@data"]')){const a=document.createElement('a');a.dataset.cp15Link='true';a.className='nav-root';a.href='/data';a.textContent='Game Data / Reconciliation';sidebar.appendChild(a);}
  const main=document.querySelector('.main');
  const onDashboard=/^#\/?dashboard$/.test(location.hash)||!location.hash;
  if(!main||!onDashboard||main.querySelector('[data-cp15-summary]')||busy)return;
  const panel=document.createElement('section');panel.dataset.cp15Summary='true';panel.className='panel';panel.innerHTML='<h2>Production Game Data</h2><p class="small">Loading signed source records separately from legacy statistics...</p>';
  main.prepend(panel);busy=true;
  fetch('/api/admin/data/summary?environment=production',{credentials:'same-origin',cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('Unavailable');return r.json()}).then(d=>{
   panel.replaceChildren();const h=document.createElement('h2');h.textContent='Production Game Data';const p=document.createElement('p');p.textContent='Signed observations: '+d.rounds+' rounds, '+d.players+' pseudonymous players. Staging and '+d.legacy.records+' legacy rows are excluded.';
   const link=document.createElement('a');link.href='/data';link.className='btn';link.textContent='Open live data and reconciliation';const note=document.createElement('p');note.className='small';note.textContent='The older cards below remain legacy operational counters. Heartbeat online is not evidence of settlement or a synchronized wallet.';panel.append(h,p,link,note);
  }).catch(()=>{panel.textContent='Game data is not available for this session. The legacy counters below are separate.'}).finally(()=>{busy=false;});
 };
 const root=document.getElementById('app');if(root)new MutationObserver(add).observe(root,{childList:true,subtree:true});add();
})();
