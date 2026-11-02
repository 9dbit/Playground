'use strict';
(() => {
  // Fragments never reach the server. Remove the key before any API call or redirect.
  let key = new URLSearchParams(location.hash.slice(1)).get('key') || '';
  let addressCleared = false;
  try { history.replaceState(null, '', location.pathname); addressCleared = true; } catch { key = ''; }

  async function openWorkspace() {
    const status = document.getElementById('development-status');
    const error = document.getElementById('development-error');
    try {
      if (!addressCleared) throw Error('The access link could not be opened. Reopen your private development link in a browser.');
      if (!key) {
        const response = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (response.ok) {
          const session = await response.json();
          if (session.setupRequired === false) { location.replace('/engine'); return; }
        }
        throw Error('Open the complete private development link you were given. The access key is missing from this address.');
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error('This development link is incomplete or invalid. Open the complete private link again.');
      const body = JSON.stringify({ key }); key = '';
      const response = await fetch('/api/auth/development', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body
      });
      const session = await response.json();
      if (!response.ok) throw Error(session.error || 'The development link is unavailable. Open a current link or use account sign in.');
      if (session.development !== true || session.setupRequired !== false) throw Error('Development access could not be confirmed. Use a current private link or account sign in.');
      status.textContent = 'Development access confirmed. Opening the dashboard...';
      location.replace('/engine');
    } catch (failure) {
      status.textContent = 'Development access is not open.';
      error.textContent = failure.message; error.hidden = false;
    } finally { key = ''; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openWorkspace, { once: true });
  else openWorkspace();
})();
