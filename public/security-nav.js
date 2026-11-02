'use strict';
(async () => {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!response.ok) { location.replace('/login'); return; }
  const account = await response.json();
  if (account.setupRequired) { location.replace('/security'); return; }
  function attach() {
    const actions = document.querySelector('.top-actions');
    if (actions && !actions.querySelector('[data-cp08-security]')) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'icon-btn';
      btn.dataset.cp08Security = 'true'; btn.textContent = account.development ? 'Development' : 'Security'; btn.title = account.development ? 'Development access and current session' : account.username + ' / ' + account.role;
      btn.addEventListener('click', () => { location.href = '/security'; }); actions.prepend(btn);
      const logout = actions.querySelector('[data-action=logout]');
      if (logout) { logout.textContent = (account.development ? 'Dev' : account.username) + ' / Sign out'; logout.title = 'Sign out and revoke this session'; }
    }
  }
  const root = document.getElementById('app');
  if (root) new MutationObserver(attach).observe(root, { childList: true, subtree: true });
  attach();
})().catch(() => {});

