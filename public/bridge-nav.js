'use strict';
// Keep the existing top bar and all gameplay assets unchanged, including narrow screens.
function attachGameBridge() {
  for (const node of document.querySelectorAll('.notice, .head p')) {
    if(node.textContent==='Zero integration adapters: Skygate 5000, UNO LUCK and Mahjong Wild are catalog entries only. No live game controls or cash balances.')
      node.textContent='Open Game Bridge for signed connection status. Heartbeats are not proof of round ingestion. No game controls or cash balances are enabled.';
    if(node.textContent==='Overview from persistent database. Integrations are not yet connected.')
      node.textContent='Catalog metrics. Open Game Bridge for live transport status.';
  }
  const footer=document.querySelector('.nav-footer');
  if(!footer||footer.querySelector('[data-game-bridge]'))return;
  const a=document.createElement('a');a.dataset.gameBridge='true';a.href='/integrations';a.textContent='Game Bridge / Connections';
  a.style.display='block';a.style.padding='12px 0';a.style.color='#d6dfff';a.style.fontWeight='700';footer.prepend(a);
}
const root=document.getElementById('app');if(root)new MutationObserver(attachGameBridge).observe(root,{childList:true,subtree:true});
attachGameBridge();
