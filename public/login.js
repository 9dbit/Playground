'use strict';
document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type=submit]');
  const message = document.getElementById('login-error');
  message.textContent = ''; button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (data.code === 'MFA_REQUIRED' || data.code === 'INVALID_MFA') {
      document.getElementById('factor-field').hidden = false;
      form.elements.code.required = true; form.elements.code.focus();
      message.textContent = data.error; return;
    }
    if (!response.ok) throw new Error(data.error || 'Sign-in failed');
    location.replace(data.setupRequired ? '/security' : '/engine');
  } catch (error) { message.textContent = error.message || 'Connection failed. Try again.'; }
  finally { button.disabled = false; }
});
