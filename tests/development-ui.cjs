'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..', 'public');
const base = 'http://127.0.0.1:8778';
const key = 'd'.repeat(43); // Synthetic fixture, never a deployed credential.
const account = { id: 'development', username: 'development-admin', displayName: 'Development Admin', role: 'owner', status: 'active', development: true, authenticationMethod: 'development-link', mfaEnabled: false, mfaVerified: false, passwordChangeRequired: false, setupRequired: false, csrf: 'synthetic-dev-csrf', sessionId: '22222222-2222-4222-8222-222222222222', expiresAt: '2027-01-01T00:00:00Z' };
const sessions = [{ id: account.sessionId, current: true, created_at: '2026-11-02T01:00:00Z', last_seen: '2026-11-02T01:01:00Z', expires_at: account.expiresAt, ip: '127.0.0.1', user_agent: 'Development browser QA' }];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const report = { suite: 'Development access browser UI with mocked API', checks: [], errors: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => report.errors.push(error.message));
    let active = false, exchanges = 0, adminRequests = 0, logoutRequests = 0, revokeRequests = 0;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), p = url.pathname;
      assert.equal(request.url().includes(key), false, 'access key must not appear in network URLs');
      assert.equal((request.headers().referer || '').includes(key), false, 'access key must not appear in referrers');
      const files = { '/development': 'development.html', '/security': 'security.html', '/assets/development.js': 'development.js', '/assets/security-ui.js': 'security-ui.js', '/assets/security.css': 'security.css', '/assets/security-nav.js': 'security-nav.js' };
      if (files[p]) {
        const file = files[p];
        return route.fulfill({ status: 200, body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : 'text/css' });
      }
      if (p === '/engine') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="app"><div class="top-actions"><button data-action="logout">Sign out</button></div><h1>Dashboard fixture</h1></div><script src="/assets/security-nav.js"></script></body></html>' });
      if (p === '/login') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><h1>Account login fixture</h1></body></html>' });
      let status = 200, data = {};
      if (p === '/api/auth/development') {
        exchanges += 1;
        assert.equal(new URL(page.url()).hash, '', 'fragment must be removed before key exchange');
        assert.equal(request.method(), 'POST');
        assert.equal(request.headers()['content-type'], 'application/json');
        if (request.postDataJSON().key !== key) { status = 401; data = { error: 'This development link is invalid or expired.' }; }
        else { active = true; data = { ...account }; }
      } else if (p === '/api/auth/session' || p === '/api/security/me') {
        if (active) data = { ...account };
        else { status = 401; data = { code: 'LOGIN_REQUIRED', error: 'Login required' }; }
      } else if (p === '/api/security/sessions') data = { items: sessions };
      else if (p === '/api/security/admins') { adminRequests += 1; status = 403; data = { code: 'DEVELOPMENT_SCOPE' }; }
      else if (p === '/api/security/sessions/revoke') {
        revokeRequests += 1;
        assert.equal(request.headers()['x-csrf-token'], account.csrf);
        assert.equal(request.postDataJSON().session_id, account.sessionId);
        active = false; data = { ok: true, signedOut: true };
      } else if (p === '/api/auth/logout') {
        logoutRequests += 1;
        assert.equal(request.headers()['x-csrf-token'], account.csrf);
        active = false; data = { ok: true };
      } else { status = 404; data = { error: 'Unmocked endpoint ' + p }; }
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    });

    await page.goto(base + '/development#key=' + key);
    await page.waitForURL('**/engine');
    await page.getByRole('button', { name: 'Development', exact: true }).waitFor();
    assert.equal(exchanges, 1);
    assert.equal(await page.getByRole('button', { name: 'Dev / Sign out', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
    report.checks.push('private fragment exchanged after URL cleanup; dashboard opens without login or MFA; key not persisted');
    report.checks.push('dashboard navigation labels the development session');

    await page.goto(base + '/development');
    await page.waitForURL('**/engine');
    assert.equal(exchanges, 1);
    report.checks.push('existing active session reopens dashboard without a key exchange');

    await page.goto(base + '/security');
    await page.getByRole('heading', { name: 'Development access', exact: true }).waitFor();
    assert.equal(await page.locator('form').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Password', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Authenticator', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Administrators & roles' }).count(), 0);
    assert.equal(adminRequests, 0);
    report.checks.push('development access page shows the session without password, MFA, or administrator forms');
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/development-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: 'test-results/development-mobile.png', fullPage: true });
    report.checks.push('development access page fits the 390px mobile viewport');

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal(revokeRequests, 1);
    report.checks.push('current development session can be revoked with CSRF and signs out');

    await page.goto(base + '/development#key=invalid');
    await page.locator('#development-error').waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(exchanges, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    report.checks.push('malformed key is removed from the URL and rejected before network exchange');

    await page.goto(base + '/development#key=' + 'e'.repeat(43));
    await page.getByText('This development link is invalid or expired.', { exact: true }).waitFor();
    assert.equal(exchanges, 2);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.getByRole('link', { name: 'Use account sign in' }).count(), 1);
    report.checks.push('rejected link displays an actionable error and account sign-in option');

    await page.goto(base + '/development');
    await page.getByText('Open the complete private development link you were given.', { exact: false }).waitFor();
    assert.equal(exchanges, 2);
    report.checks.push('missing key never creates a development session');

    await page.goto(base + '/development#key=' + key);
    await page.waitForURL('**/engine');
    await page.goto(base + '/security');
    await page.getByRole('heading', { name: 'Development access', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal(logoutRequests, 1);
    report.checks.push('normal sign-out action revokes development access with CSRF');

    assert.equal(report.errors.length, 0);
    report.result = 'PASS';
    fs.writeFileSync('test-results/development-ui.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
