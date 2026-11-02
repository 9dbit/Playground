'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const E = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let account, csrf = '', enrollment = null, codes = null, admins = [], toastTimer;
  const date = x => new Date(x).toLocaleString();
  const roleOptions = ['owner', 'operator', 'support', 'viewer'];
  function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
  async function request(url, method = 'GET', body) {
    const headers = { 'Accept': 'application/json', 'X-CSRF-Token': csrf };
    const options = { method, credentials: 'same-origin', headers };
    if (body) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const r = await fetch(url, options), data = await r.json();
    if (r.status === 401 && data.code === 'LOGIN_REQUIRED') { location.replace('/login'); throw Error('Your session has expired'); }
    if (!r.ok) throw Error(data.error || 'Request failed');
    if (data.csrf) { csrf = data.csrf; account = data; }
    return data;
  }
  function field(label, name, type = 'text', opts = '') {
    return '<label>' + label + '<input name="' + name + '" type="' + type + '" ' + opts + '></label>';
  }
  function reauth(factor = true) {
    return field('Your current password', 'current_password', 'password', 'required autocomplete="current-password" maxlength="128"') +
      (factor ? field('Your authenticator or unused recovery code', 'code', 'text', 'required autocomplete="one-time-code" maxlength="48" spellcheck="false"') : '');
  }
  function render(sessions = []) {
    $('identity').textContent = account.displayName + ' / ' + account.role;
    const alert = $('page-alert');
    if (account.development) {
      $('identity').textContent = account.displayName + ' / Development';
      document.querySelector('.page-heading h1').textContent = 'Development access';
      document.querySelector('.page-heading .subtle').textContent = 'Your development dashboard session and access status.';
      alert.className = 'notice';
      alert.textContent = 'Development access is active. Open the dashboard directly; no password or authenticator setup is needed for this session.';
      const rows = sessions.map(s => '<tr><td><span class="tag success">This development session</span></td><td>' + E(s.ip) + '<br><small>' + E(s.user_agent) + '</small></td><td>' + E(date(s.last_seen)) + '</td><td>' + E(date(s.expires_at)) + '</td><td><button class="danger" data-action="revoke" data-id="' + E(s.id) + '" type="button">Revoke</button></td></tr>').join('');
      $('security-content').innerHTML = '<section class="panel"><div class="panel-title"><h2>Development dashboard access</h2><span class="tag success">Active</span></div><p class="subtle">You can use the operational dashboard with this development session. Administrator credentials and authenticator settings are managed through account sign in.</p><p class="subtle">Session expires: ' + E(date(account.expiresAt)) + '. Keep your private development link to open a new session.</p><a class="primary" href="/engine">Open admin dashboard</a></section><section class="panel"><h2>Your development session</h2><p class="subtle">Revoking this session signs out this browser. No password or authenticator setup is required to reopen a valid development link.</p><div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>Client</th><th>Last seen</th><th>Expires</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
      return;
    }
    alert.className = 'notice' + (account.setupRequired ? ' warning' : '');
    alert.textContent = account.passwordChangeRequired ? 'Step 1 of 2: change your temporary password. Operational access stays locked until you also verify an authenticator.' :
      !account.mfaEnabled ? 'Step 2 of 2: enroll an authenticator and verify a code. Do not share your setup key. Keep recovery codes offline.' :
      'Password and authenticator setup complete. Your account can access only the actions permitted by its role.';
    const password = '<section class="panel"><div class="panel-title"><h2>Password</h2><span class="tag' + (account.passwordChangeRequired ? '' : ' success') + '">' + (account.passwordChangeRequired ? 'Change required' : 'Configured') + '</span></div><p class="subtle">Use a new password with 15 to 128 characters. Changing it closes all other sessions.</p><form data-task="password">' + reauth(account.mfaEnabled) + field('New password', 'new_password', 'password', 'required minlength="15" maxlength="128" autocomplete="new-password"') + field('Confirm new password', 'confirm_password', 'password', 'required minlength="15" maxlength="128" autocomplete="new-password"') + '<button class="primary" type="submit">Change password</button></form></section>';
    let mfa = '<section class="panel"><div class="panel-title"><h2>Authenticator</h2><span class="tag' + (account.mfaEnabled ? ' success' : '') + '">' + (account.mfaEnabled ? 'Enabled' : 'Enrollment required') + '</span></div>';
    if (account.passwordChangeRequired) mfa += '<p class="subtle">Change the temporary password first. Then add Playground to your authenticator app using a manual setup key.</p>';
    else if (account.mfaEnabled) mfa += '<p class="subtle">Sign-in requires a time-based code or a single-use recovery code. Already-used authenticator codes are rejected.</p><details><summary>Replace or recover your authenticator</summary><p class="micro">This closes all sessions and immediately requires a new authenticator enrollment. An unused recovery code can be used when the previous authenticator is unavailable.</p><form data-task="mfa/reset">' + reauth(true) + '<button class="danger" type="submit">Reset and re-enroll</button></form></details>';
    else if (!enrollment) mfa += '<p class="subtle">Confirm your password to start a 10-minute enrollment. Add a time-based account named Playground in your authenticator app.</p><form data-task="mfa/begin">' + reauth(false) + '<button class="primary" type="submit">Start enrollment</button></form>';
    else mfa += '<p class="subtle">Enter this key manually in your authenticator. Select time-based codes, 6 digits, a 30-second period, and SHA1 where asked.</p><label>Private setup key<input id="setup-key" class="setup-key" readonly type="password" value="' + E(enrollment.secret) + '" autocomplete="off"></label><div class="actions"><button type="button" class="secondary" data-action="copy-key">Copy key</button><button type="button" class="secondary" data-action="show-key">Show / hide</button></div><hr class="divider"><form data-task="mfa/confirm">' + field('Code from your authenticator', 'code', 'text', 'required pattern="[0-9]{6}" minlength="6" maxlength="6" inputmode="numeric" autocomplete="one-time-code"') + '<button class="primary" type="submit">Verify and enable</button></form>';
    mfa += '</section>';
    const recovery = codes ? '<section class="panel recovery"><h2>Save your recovery codes now</h2><p class="subtle">These eight codes are shown once. Each code works once. Store them offline; refreshing this page removes this display.</p><textarea id="recovery-codes" readonly autocomplete="off" spellcheck="false">' + E(codes.join('\n')) + '</textarea><div class="actions"><button class="secondary" type="button" data-action="download-codes">Save codes privately</button><button class="primary" type="button" data-action="dismiss-codes">I saved my codes</button></div></section>' : '';
    const sessionRows = sessions.map(s => '<tr><td>' + (s.current ? '<span class="tag success">This session</span>' : E(s.id.slice(0, 8))) + '</td><td>' + E(s.ip) + '<br><small>' + E(s.user_agent) + '</small></td><td>' + E(date(s.last_seen)) + '</td><td>' + E(date(s.expires_at)) + '</td><td><button class="danger" data-action="revoke" data-id="' + E(s.id) + '" type="button">Revoke</button></td></tr>').join('');
    const sessionPanel = '<section class="panel"><h2>Your active sessions</h2><p class="subtle">Sessions expire after 8 hours, or after 30 minutes of inactivity. Revocation is enforced on the server.</p><div class="table-wrap"><table class="table"><thead><tr><th>Session</th><th>Client</th><th>Last seen</th><th>Expires</th><th>Action</th></tr></thead><tbody>' + sessionRows + '</tbody></table></div></section>';
    let team = '';
    if (!account.setupRequired && account.role === 'owner') {
      const rows = admins.map(a => '<tr><td>' + E(a.username) + '<br><small>' + E(a.displayName) + '</small></td><td>' + E(a.role) + '</td><td>' + E(a.status) + '</td><td>' + (a.mfaEnabled ? 'Enabled' : 'Enrollment needed') + '</td><td><button type="button" class="secondary" data-action="edit-admin" data-id="' + E(a.id) + '" ' + (a.id === account.id ? 'disabled' : '') + '>Edit access</button></td></tr>').join('');
      team = '<section class="panel"><h2>Administrators &amp; roles</h2><p class="subtle">Owner manages access. Operator manages games and content. Support manages tickets and notification records. Viewer reads approved operational summaries. New accounts must change their password and enroll MFA.</p><div class="table-wrap"><table class="table"><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Authenticator</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table></div><hr class="divider"><details><summary>Create an administrator</summary><form data-task="admins"><div class="fields-two">' + field('Username', 'username', 'text', 'required pattern="[a-z0-9][a-z0-9_.-]{2,63}" maxlength="64" autocomplete="off"') + field('Display name', 'display_name', 'text', 'required maxlength="100" autocomplete="off"') + '<label>Role<select name="role">' + roleOptions.map(x => '<option value="' + x + '" ' + (x === 'viewer' ? 'selected' : '') + '>' + x + '</option>').join('') + '</select></label>' + field('Temporary password', 'temporary_password', 'password', 'required minlength="15" maxlength="128" autocomplete="new-password"') + '</div><p class="micro">Share the temporary password privately with the intended administrator. It is not returned or emailed by the server.</p>' + reauth(true) + '<button class="primary" type="submit">Create account</button></form></details><section id="edit-access" hidden></section></section>';
    }
    $('security-content').innerHTML = recovery + '<div class="security-grid">' + password + mfa + '</div>' + sessionPanel + team + (!account.setupRequired ? '<a class="primary" href="/engine">Open admin dashboard</a>' : '');
  }
  async function load() {
    account = await request('/api/auth/session');
    const sessions = await request('/api/security/sessions');
    admins = !account.development && account.role === 'owner' && !account.setupRequired ? (await request('/api/security/admins')).items : [];
    render(sessions.items);
  }
  document.addEventListener('submit', async event => {
    const form = event.target.closest('form[data-task]'); if (!form) return;
    event.preventDefault(); const button = form.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const task = form.dataset.task, body = Object.fromEntries(new FormData(form));
      if (task === 'password') { if (body.new_password !== body.confirm_password) throw Error('New passwords do not match'); delete body.confirm_password; }
      if (task === 'mfa/reset' && !confirm('Reset this authenticator and require enrollment again?')) return;
      const data = await request('/api/security/' + task, task.startsWith('admins/') ? 'PATCH' : 'POST', body);
      if (task === 'mfa/begin') enrollment = data;
      if (task === 'mfa/confirm') { enrollment = null; codes = data.recoveryCodes; }
      if (task === 'mfa/reset' || task === 'password') { enrollment = null; codes = null; }
      toast(task === 'mfa/confirm' ? 'Authenticator verified. Save your recovery codes.' : 'Saved successfully.');
      await load();
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  document.addEventListener('click', async event => {
    const btn = event.target.closest('[data-action]'); if (!btn) return;
    try {
      const action = btn.dataset.action;
      if (action === 'copy-key') { await navigator.clipboard.writeText(enrollment.secret); toast('Setup key copied. Do not share it.'); }
      if (action === 'show-key') $('setup-key').type = $('setup-key').type === 'password' ? 'text' : 'password';
      if (action === 'dismiss-codes') { codes = null; await load(); }
      if (action === 'download-codes') {
        const blob = new Blob(['Playground recovery codes for ' + account.username + '\nStore privately. Each code works once.\n\n' + codes.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'playground-recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (action === 'revoke') {
        if (!confirm('Revoke this session?')) return;
        const data = await request('/api/security/sessions/revoke', 'POST', { session_id: btn.dataset.id });
        if (data.signedOut) location.replace('/login'); else { toast('Session revoked.'); await load(); }
      }
      if (action === 'edit-admin') {
        const a = admins.find(x => x.id === btn.dataset.id); if (!a || a.id === account.id) return;
        const target = $('edit-access'); target.hidden = false;
        target.innerHTML = '<hr class="divider"><h2>Edit access: ' + E(a.username) + '</h2><p class="micro">Saving revokes every session for this administrator.</p><form data-task="admins/' + E(a.id) + '"><div class="fields-two"><label>Role<select name="role">' + roleOptions.map(x => '<option ' + (x === a.role ? 'selected' : '') + '>' + x + '</option>').join('') + '</select></label><label>Status<select name="status"><option value="active" ' + (a.status === 'active' ? 'selected' : '') + '>active</option><option value="disabled" ' + (a.status === 'disabled' ? 'selected' : '') + '>disabled</option></select></label></div>' + reauth(true) + '<button class="primary" type="submit">Save access change</button></form>';
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (error) { toast(error.message); }
  });
  $('sign-out').addEventListener('click', async () => {
    try { await request('/api/auth/logout', 'POST', {}); location.replace('/login'); } catch (e) { toast(e.message); }
  });
  load().catch(error => { $('page-alert').textContent = error.message; $('page-alert').className = 'notice warning'; });
})();

