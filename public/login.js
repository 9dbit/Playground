'use strict';
fetch('/api/auth/recovery-options', { credentials: 'same-origin', cache: 'no-store' })
  .then(response => response.ok ? response.json() : null)
  .then(options => {
    if (!options?.environmentCredentials) return;
    document.getElementById('recovery-help').innerHTML =
      '<p>Pemilik akun master yang memiliki akses Railway dapat memperbarui kredensial:</p>' +
      '<ol><li>Buka service Playground untuk website ini di Railway, lalu pilih <strong>Variables</strong>.</li>' +
      '<li>Ubah <code>ADMIN_USERNAME</code> atau <code>ADMIN_PASSWORD</code>. Username: 3–64 karakter huruf kecil, angka, titik, garis bawah atau tanda minus. Password: 15–128 karakter.</li>' +
      '<li>Simpan dan pilih <strong>Deploy</strong>. Setelah status <strong>SUCCESS</strong>, masuk menggunakan kredensial baru.</li></ol>' +
      '<p>Authenticator yang sudah terdaftar tetap digunakan. Jika lupa kodenya, gunakan recovery code. Staff lain dapat meminta bantuan owner.</p>';
  }).catch(() => {});
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
