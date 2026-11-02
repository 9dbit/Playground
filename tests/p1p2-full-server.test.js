'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { createFixture } = require('./helpers/full-server.cjs');
const { schemas, validateSetting } = require('../engine/settings-schema');
const ROOT = path.join(__dirname, '..');
const validSettings = {
  general: { site_title: 'CP14 QA', currency: 'Demo Coin', currency_symbol: 'DC', timezone: 'Asia/Jakarta',
    base_color: '#4939f5', secondary_color: '#e2d273', per_page: 100, currency_format: 'symbol',
    register_bonus: 0, demo_balance: 0, transfer_fixed: 0, transfer_percent: 0, gameplay_bonus_count: 0, gameplay_bonus: 0 },
  logo: { logo_url: '/assets/example.png', favicon_url: '' },
  configuration: { name: 'QA', read_only: false, bridge_enabled: false },
  notification: { in_app_enabled: true, email_enabled: false, sender: 'QA' },
  seo: { meta_title: 'QA', meta_description: 'Test only', keywords: 'qa' },
  kyc: { kyc_enabled: false, retention_days: 30 }, social: { google: false, apple: false },
  language: { default_locale: 'en', supported: 'en,id' }, extensions: { registry_url: '', enabled: false },
  cron: { enabled: false, interval_minutes: 10, description: 'Local cleanup' },
  maintenance: { enabled: false, message: 'Maintenance' }, gdpr: { notice: 'Test notice', required: false },
  css: { draft: '/* stored, not executed */' }, sitemap: { enabled: true, endpoint: '/sitemap.xml' },
  robots: { rules: 'User-agent: *\nDisallow: /api/\n' }
};
function literalRoutes(text) {
  // A string prefix in app.get('/assets/' + filename, ...) is not a full route.
  return [...text.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'\s*,/g)]
    .map(match => match[1] + ' ' + match[2].replace(/:[^/]+/g, ':param'));
}
test('route guard distinguishes complete literal routes from dynamic asset prefixes', () => {
  const exact = literalRoutes("app.get('/x/:id',fn); app.get('/x/:gid',fn); app.get('/assets/' + filename,fn)");
  assert.deepEqual(exact, ['get /x/:param', 'get /x/:param']);
  assert.equal(new Set(exact).size, 1, 'Different parameter names must not hide duplicate routes');
});
test('settings schemas cover 15 form modules and reject unknown or incorrectly typed fields', () => {
  assert.equal(Object.keys(schemas).length, 15);
  for (const [key, value] of Object.entries(validSettings)) assert.equal(validateSetting(key, value).valid, true, key);
  for (const [key, value] of [
    ['general', { per_page: -10 }], ['general', { per_page: '100' }], ['general', { register_bonus: -500 }],
    ['general', { transfer_percent: 101 }], ['general', { timezone: 'Made/Up' }], ['general', { base_color: 'red' }],
    ['general', { injected: true }], ['general', { gameplay_bonus: 1.5 }], ['kyc', { retention_days: 0 }],
    ['cron', { enabled: 'true' }], ['cron', { interval_minutes: 1 }], ['logo', { logo_url: 'javascript:alert(1)' }],
    ['social', { google: 1 }], ['language', { default_locale: 'en', supported: 'id' }],
    ['extensions', { registry_url: 'https://user:secret@example.com' }], ['sitemap', { endpoint: '/other.xml' }],
    ['unknown-module', {}], ['pages', { configuration: 'arbitrary' }]
  ]) assert.equal(validateSetting(key, value).valid, false, key + ' ' + JSON.stringify(value));
});

test('CP14: all P1/P2 findings closed through actual server.js and PostgreSQL', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 180000
}, async t => {
  const f = await createFixture('cp14-full-server'); const { pool, request: req } = f;
  const report = { release: '0.14.0', source: 'actual server.js, middleware, routing and PostgreSQL',
    productionContacted: false, productionModified: false, checks: [], startedAt: new Date().toISOString() };
  t.after(async () => {
    report.finishedAt = new Date().toISOString(); report.result = report.checks.every(x => x.status === 'PASS') ? 'PASS' : 'FAIL';
    fs.mkdirSync(path.join(ROOT, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'test-results/cp14-remediation.json'), JSON.stringify(report, null, 2));
    await f.close();
  });
  async function check(id, title, fn) {
    await t.test(id + ': ' + title, async () => {
      try { const evidence = await fn(); report.checks.push({ id, title, status: 'PASS', evidence }); }
      catch (error) { report.checks.push({ id, title, status: 'FAIL', error: error.message }); throw error; }
    });
  }
  assert.equal(f.health.version, '0.14.0');
  const gid = 'aaaaaaaa-1111-4111-8111-111111111111', other = 'bbbbbbbb-2222-4222-8222-222222222222';
  const p1 = 'abcdefab-1111-4111-8111-111111111111', p2 = 'bcdefabc-2222-4222-8222-222222222222';
  await pool.query('INSERT INTO gameops_games(id,name,slug,code,platform) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
    [gid, 'CP14 Main', 'cp14-main', 'QA', 'Web', other, 'CP14 Other', 'cp14-other', 'Q2', 'Web']);
  await pool.query("INSERT INTO gameops_players(id,game_id,player_ref,last_seen) VALUES($1,$2,'blocked-older',now()-interval '10 days'),($3,$2,'active-older',now()-interval '10 days')", [p1, gid, p2]);
  await pool.query("INSERT INTO gameops_player_profiles(player_id,local_status) VALUES($1,'blocked_locally')", [p1]);
  await pool.query("INSERT INTO gameops_players(game_id,player_ref,last_seen) SELECT $1,'newer-active-'||n,now() FROM generate_series(1,205) n", [gid]);
  for (let i = 0; i < 8; i++) await pool.query('INSERT INTO gameops_events(event_id,game_id,round_id,player_ref,stake,payout,occurred_at) VALUES($1,$2,$3,$4,100,$5,now())',
    ['cp14-event-' + i, gid, 'cp14-round-' + i, i % 2 ? 'active-older' : 'blocked-older', i % 2 ? 150 : 0]);
  const gameConfig = { name: 'CP14 Main', code: 'QA', platform: 'Web', demo_chance: 50, winning_chance: 50, win_amount: 50,
    invest_enabled: false, min_invest: 1, max_invest: 1000, trending: false, featured: false, instructions: 'QA only', version: 1 };
  assert.equal((await req('/api/admin/deep/games/' + gid, 'PUT', gameConfig)).status, 200);
  const ticket = (await req('/api/admin/tickets', 'POST', { subject: 'CP14 ticket', requester_ref: 'qa', priority: 'Medium' })).data.item;
  const subscriber = (await req('/api/admin/deep/subscribers', 'POST', { contact: 'cp14@example.test' })).data.item;
  const diamond = (await pool.query("INSERT INTO gameops_requests(player_ref,amount) VALUES('blocked-older',50) RETURNING id")).rows[0];
  const configBody = async overrides => ({ ...(await req('/api/admin/deep/games/' + gid)).data.item, ...overrides });
  const versionOf = async key => (await req('/api/admin/settings')).data.items.find(x => x.key === key)?.version || 0;
  const setting = async (key, value, version) => req('/api/admin/settings/' + key, 'PUT', { value, expected_version: version ?? await versionOf(key) });
  const artwork = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#abcd22' } }).png().toBuffer();
  const dataURL = (bytes, mime = 'image/png') => 'data:' + mime + ';base64,' + bytes.toString('base64');
  await check('C01', 'authorization, CSRF and legacy bridge controls remain enforced', async () => {
    assert.equal((await req('/api/admin/summary', 'GET', undefined, null)).status, 401);
    assert.equal((await req('/api/admin/settings/general', 'PUT', { value: { site_title: 'No' }, expected_version: 0 }, 'owner', { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await req('/api/admin/settings/general', 'PUT', { value: { site_title: 'No' }, expected_version: 0 }, 'support')).status, 403);
    assert.equal((await req('/api/admin/virtual-wallets/' + p1 + '/adjust', 'POST', { action: 'credit', amount: 10, note: 'QA credit', idempotency_key: crypto.randomUUID() }, 'viewer')).status, 403);
    assert.equal((await req('/api/v1/game-events', 'POST', {}, null)).status, 410);
    assert.equal((await req('/api/v2/game-bridge', 'POST', {}, null)).status, 401);
    return { anonymous: 401, csrf: 403, roleDenied: 403, oldBridge: 410 };
  });
  await check('F01', 'canonical Game Log route actually honors filters and pagination', async () => {
    const r = await req('/api/admin/deep/games/' + gid + '/rounds?result=win&limit=1&page=2');
    assert.equal(r.status, 200); assert.equal(r.data.items.length, 1); assert.equal(r.data.total, 4);
    assert.equal(r.data.page, 2); assert.equal(r.data.pages, 4); assert.equal(r.data.items[0].result, 'win');
    assert.equal((await req('/api/admin/deep/games/' + gid + '/rounds?limit=101')).status, 400);
    const routes = [];
    for (const name of ['server.js', ...fs.readdirSync(path.join(ROOT, 'engine')).filter(x => x.endsWith('.js')).map(x => 'engine/' + x)]) {
      routes.push(...literalRoutes(fs.readFileSync(path.join(ROOT, name), 'utf8')));
    }
    const duplicates = routes.filter((route, index) => routes.indexOf(route) !== index);
    assert.deepEqual(duplicates, [], 'Duplicate fully literal canonical routes; dynamic asset prefixes are not routes');
    return { totalFiltered: r.data.total, pageSize: r.data.items.length, duplicateRoutes: 0, literalRouteCount: routes.length };
  });
  await check('F05', 'older blocked users are found before pagination, with stable counts and search', async () => {
    const r = await req('/api/admin/deep/players?state=banned&limit=25&page=1');
    assert.equal(r.status, 200); assert.equal(r.data.total, 1); assert.equal(r.data.items[0].id, p1);
    const alias = await req('/api/admin/players?state=banned'); assert.equal(alias.data.items[0].id, p1);
    const pages = await Promise.all([req('/api/admin/deep/players?state=active&limit=100&page=1'), req('/api/admin/deep/players?state=active&limit=100&page=2'), req('/api/admin/deep/players?state=active&limit=100&page=3')]);
    assert.equal(pages[0].data.total, 206); assert.equal(pages[2].data.items.length, 6);
    assert.equal(new Set(pages.flatMap(x => x.data.items.map(y => y.id))).size, 206);
    const search = await req('/api/admin/deep/players?state=all&q=blocked-older'); assert.equal(search.data.total, 1);
    for (const query of ['state=unknown', 'limit=101', 'page=0', 'q[a]=1']) assert.equal((await req('/api/admin/deep/players?' + query)).status, 400, query);
    return { newerActiveUsers: 205, olderBlockedFound: true, totalActive: 206, uniquePagedRows: 206 };
  });
  await check('F02', 'typed validation for every settings form; invalid existing values are preserved until explicitly corrected', async () => {
    for (const [key, value] of Object.entries(validSettings)) {
      if (key === 'seo') continue;
      const r = await setting(key, value); assert.equal(r.status, 200, key + ': ' + r.text);
    }
    const version = await versionOf('general');
    for (const invalid of [{ per_page: -10 }, { register_bonus: -500 }, { transfer_percent: 101 }, { timezone: 'Wrong/Zone' }, { base_color: 'bad' }, { extra: true }, { per_page: '100' }]) {
      const r = await setting('general', invalid, version); assert.equal(r.status, 400); assert.ok(r.data.details.fields.length);
    }
    for (const key of ['pages', 'policies', 'templates', 'frontend', 'not-a-module']) assert.equal((await setting(key, { configuration: '{}' }, 0)).status, 400);
    assert.equal(await versionOf('general'), version);
    await pool.query("UPDATE gameops_settings SET value=$1,version=7 WHERE key='logo'", [JSON.stringify({ logo_url: 'bad-url', historical_note: 'preserve this old value' })]);
    const before = (await req('/api/admin/settings')).data.items.find(x => x.key === 'logo');
    assert.equal(before.validation.valid, false); assert.equal(before.value.historical_note, 'preserve this old value');
    const corrected = await setting('logo', validSettings.logo, 7); assert.equal(corrected.status, 200); assert.equal(corrected.data.item.version, 8);
    const archive = await pool.query("SELECT value FROM gameops_settings_versions WHERE key='logo' AND version=7");
    assert.equal(archive.rows[0].value.historical_note, 'preserve this old value');
    return { typedForms: Object.keys(schemas).length, contentModulesUseCMS: 4, legacyOriginalArchived: true };
  });
  await check('F03', 'missing version is rejected and simultaneous writers cannot silently overwrite', async () => {
    assert.equal((await req('/api/admin/settings/general', 'PUT', { value: { site_title: 'No precondition' } })).status, 428);
    const first = await Promise.all([
      setting('seo', { meta_title: 'Writer one' }, 0), setting('seo', { meta_title: 'Writer two' }, 0)
    ]);
    assert.deepEqual(first.map(x => x.status).sort(), [200, 409]);
    const current = await versionOf('general');
    const second = await Promise.all([
      setting('general', { ...validSettings.general, site_title: 'Tab A' }, current),
      setting('general', { ...validSettings.general, site_title: 'Tab B' }, current)
    ]);
    assert.deepEqual(second.map(x => x.status).sort(), [200, 409]); assert.equal(await versionOf('general'), current + 1);
    assert.equal((await setting('general', { site_title: 'Stale' }, current)).status, 409);
    return { concurrentCreate: [200, 409], concurrentUpdate: [200, 409], missingPrecondition: 428 };
  });
  await check('F06', 'new ticket replies use the authenticated actor and leave historical attribution untouched', async () => {
    await pool.query("INSERT INTO gameops_ticket_messages(ticket_id,author,body) VALUES($1,'admin','Historical legacy reply')", [ticket.id]);
    const reply = await req('/api/admin/deep/tickets/' + ticket.id + '/replies', 'POST', { body: 'Actual Support reply', author: 'spoof_owner' }, 'support');
    assert.equal(reply.status, 201); assert.equal(reply.data.item.author, 'fixture_support');
    const thread = await req('/api/admin/deep/tickets/' + ticket.id, 'GET', undefined, 'support');
    assert.equal(thread.data.messages.find(x => x.body === 'Actual Support reply').author, 'fixture_support');
    assert.equal(thread.data.messages.find(x => x.body === 'Historical legacy reply').author, 'admin');
    const audit = await pool.query("SELECT actor FROM gameops_audit WHERE action='ticket.reply.recorded' AND resource=$1 ORDER BY id DESC LIMIT 1", [ticket.id]);
    assert.equal(audit.rows[0].actor, 'fixture_support'); return { persistedAuthor: 'fixture_support', historicalRowsUnchanged: true };
  });
  let pageContent;
  await check('F07', 'Pages and Policies have distinct canonical URLs, safe legacy links and a deduplicated sitemap', async () => {
    const first = await req('/api/admin/deep/content/page', 'POST', { title: 'Page privacy', slug: 'shared-privacy', body: 'Page body only', status: 'published' });
    const second = await req('/api/admin/deep/content/policy', 'POST', { title: 'Policy privacy', slug: 'shared-privacy', body: 'Policy body only', status: 'published' });
    assert.equal(first.status, 201); assert.equal(second.status, 201); pageContent = first.data.item;
    assert.equal(first.data.item.public_path, '/info/page/shared-privacy'); assert.equal(second.data.item.public_path, '/info/policy/shared-privacy');
    const legacy = await req('/info/shared-privacy', 'GET', undefined, null); assert.equal(legacy.status, 300);
    assert.ok(legacy.text.includes('/info/page/shared-privacy') && legacy.text.includes('/info/policy/shared-privacy'));
    const a = await req('/info/page/shared-privacy', 'GET', undefined, null), b = await req('/info/policy/shared-privacy', 'GET', undefined, null);
    assert.equal(a.status, 200); assert.ok(a.text.includes('Page body only') && !a.text.includes('Policy body only'));
    assert.equal(b.status, 200); assert.ok(b.text.includes('Policy body only') && !b.text.includes('Page body only'));
    const only = await req('/api/admin/deep/content/page', 'POST', { title: 'Only page', slug: 'single-legacy', body: 'Preserved', status: 'published' }); assert.equal(only.status, 201);
    const redirect = await req('/info/single-legacy', 'GET', undefined, null); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/info/page/single-legacy');
    const sitemap = await req('/sitemap.xml', 'GET', undefined, null);
    const locations = [...sitemap.text.matchAll(/<loc>(.*?)<\/loc>/g)].map(x => x[1]);
    assert.equal(new Set(locations).size, locations.length); assert.ok(locations.includes(f.base + '/info/page/shared-privacy')); assert.ok(locations.includes(f.base + '/info/policy/shared-privacy'));
    const list = await req('/api/admin/deep/content/page'); assert.equal(list.data.items.find(x => x.slug === 'shared-privacy').legacy_url_ambiguous, true);
    assert.equal((await req('/api/admin/deep/content/page', 'POST', { title: 'Duplicate', slug: 'shared-privacy', body: '', status: 'draft' })).status, 409);
    return { legacyConflict: 300, legacyUniqueRedirect: 308, canonicalPaths: 2, sitemapDuplicates: 0 };
  });
  await check('F08', 'artwork is fully decoded, bounded and normalized before committing', async () => {
    const endpoint = '/api/admin/deep/games/' + gid + '/image';
    assert.equal((await req(endpoint, 'POST', { data: 'data:image/jpeg;base64,/9g=' })).status, 400);
    assert.equal((await req(endpoint, 'POST', { data: dataURL(artwork, 'image/jpeg') })).status, 400);
    const jpeg = await sharp(artwork).withExif({ IFD0: { Artist: 'CP14 synthetic metadata' } }).jpeg().toBuffer();
    assert.equal((await req(endpoint, 'POST', { data: dataURL(jpeg.subarray(0, Math.floor(jpeg.length / 2)), 'image/jpeg') })).status, 400);
    const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#ff0000' } }).png().toBuffer();
    assert.equal((await req(endpoint, 'POST', { data: dataURL(wide) })).status, 400);
    const pixels = await sharp({ create: { width: 4001, height: 4001, channels: 3, background: '#ff0000' } }).png().toBuffer();
    assert.equal((await req(endpoint, 'POST', { data: dataURL(pixels) })).status, 400);
    for (const [bytes, mime] of [[artwork, 'image/png'], [jpeg, 'image/jpeg'], [await sharp(artwork).webp().toBuffer(), 'image/webp']]) {
      const r = await req(endpoint, 'POST', { data: dataURL(bytes, mime) }); assert.equal(r.status, 200, r.text);
      assert.equal(r.data.artwork.mime, 'image/webp');
      const served = await req(endpoint); assert.match(served.headers.get('content-type'), /image\/webp/);
      const meta = await sharp(served.bytes).metadata(); assert.equal(meta.width, 40); assert.equal(meta.height, 30);
      assert.equal(meta.exif, undefined); assert.equal(meta.xmp, undefined);
    }
    return { truncatedRejected: true, formatMismatchRejected: true, dimensionAndPixelLimit: true, acceptedFormats: ['PNG', 'JPEG', 'WebP'], storedFormat: 'WebP', metadataStripped: true };
  });
  await check('F04', 'all operational business writes roll back when their audit insert fails', async () => {
    await pool.query('CREATE TABLE cp14_fault_actions(action text PRIMARY KEY)');
    await pool.query("CREATE FUNCTION cp14_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM cp14_fault_actions WHERE action=NEW.action) THEN RAISE EXCEPTION 'CP14 injected audit failure'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER cp14_audit_fault BEFORE INSERT ON gameops_audit FOR EACH ROW EXECUTE FUNCTION cp14_fail_audit()');
    async function rollbackCase(action, path, method, body, sql, params = [], role = 'owner') {
      const before = (await pool.query(sql, params)).rows;
      const audits = (await pool.query('SELECT count(*)::int AS n FROM gameops_audit WHERE action=$1', [action])).rows[0].n;
      await pool.query('INSERT INTO cp14_fault_actions(action) VALUES($1)', [action]);
      try {
        const r = await req(path, method, body, role); assert.equal(r.status, 500, action + ': ' + r.text);
        assert.deepEqual((await pool.query(sql, params)).rows, before, action + ' must roll back all changed columns');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM gameops_audit WHERE action=$1', [action])).rows[0].n, audits);
      } finally { await pool.query('DELETE FROM cp14_fault_actions WHERE action=$1', [action]); }
    }
    await rollbackCase('game.created', '/api/admin/games', 'POST', { name: 'Must not exist', slug: 'fail-game', code: 'FAIL', platform: 'Web' }, "SELECT * FROM gameops_games WHERE slug='fail-game'");
    await rollbackCase('game.status_changed', '/api/admin/games/' + gid, 'PATCH', { status: 'Active' }, 'SELECT * FROM gameops_games WHERE id=$1', [gid]);
    await rollbackCase('game.config.updated', '/api/admin/deep/games/' + gid, 'PUT', await configBody({ winning_chance: 12 }), 'SELECT * FROM gameops_game_profiles WHERE game_id=$1', [gid]);
    await rollbackCase('game.image.updated', '/api/admin/deep/games/' + gid + '/image', 'POST', { data: dataURL(artwork) }, 'SELECT * FROM gameops_game_profiles WHERE game_id=$1', [gid]);
    const profile = (await req('/api/admin/deep/players/' + p1)).data.item;
    await rollbackCase('player.metadata.updated', '/api/admin/deep/players/' + p1, 'PUT', { ...profile, first_name: 'Changed', admin_note: 'Should roll back' }, 'SELECT * FROM gameops_player_profiles WHERE player_id=$1', [p1]);
    await rollbackCase('request.reviewed', '/api/admin/requests/' + diamond.id, 'PATCH', { status: 'approved', note: 'Audit should fail' }, 'SELECT * FROM gameops_requests WHERE id=$1', [diamond.id]);
    await rollbackCase('ticket.created', '/api/admin/tickets', 'POST', { subject: 'Uncommitted ticket', requester_ref: 'qa', priority: 'High' }, "SELECT * FROM gameops_tickets WHERE subject='Uncommitted ticket'");
    await rollbackCase('ticket.status_changed', '/api/admin/tickets/' + ticket.id, 'PATCH', { status: 'Closed' }, 'SELECT * FROM gameops_tickets WHERE id=$1', [ticket.id]);
    await rollbackCase('ticket.reply.recorded', '/api/admin/deep/tickets/' + ticket.id + '/replies', 'POST', { body: 'Uncommitted reply' }, 'SELECT * FROM gameops_ticket_messages WHERE ticket_id=$1 ORDER BY id', [ticket.id], 'support');
    await rollbackCase('notification.recorded', '/api/admin/deep/notifications', 'POST', { recipient_ref: 'qa', title: 'Uncommitted', body: 'Failure' }, "SELECT * FROM gameops_notifications WHERE title='Uncommitted'");
    await rollbackCase('subscriber.created', '/api/admin/deep/subscribers', 'POST', { contact: 'rollback@example.test' }, "SELECT * FROM gameops_subscribers WHERE contact='rollback@example.test'");
    await rollbackCase('subscriber.status.updated', '/api/admin/deep/subscribers/' + subscriber.id, 'PATCH', { status: 'unsubscribed' }, 'SELECT * FROM gameops_subscribers WHERE id=$1', [subscriber.id]);
    await rollbackCase('content.created', '/api/admin/deep/content/page', 'POST', { title: 'Rollback', slug: 'rollback', body: 'Not saved', status: 'published' }, "SELECT * FROM gameops_content WHERE slug='rollback'");
    const content = (await req('/api/admin/deep/content/page/' + pageContent.id)).data.item;
    await rollbackCase('content.updated', '/api/admin/deep/content/page/' + pageContent.id, 'PUT', { ...content, title: 'Not saved' }, 'SELECT * FROM gameops_content WHERE id=$1', [pageContent.id]);
    await rollbackCase('settings.saved', '/api/admin/settings/general', 'PUT', { value: { ...validSettings.general, site_title: 'Not committed' }, expected_version: await versionOf('general') }, "SELECT * FROM gameops_settings WHERE key='general'");
    await rollbackCase('admin.profile.updated', '/api/admin/ops/profile', 'PUT', { displayName: 'Not committed' }, 'SELECT display_name,updated_at FROM gameops_admin_accounts WHERE id=$1', [f.accounts.get('viewer').id], 'viewer');
    await rollbackCase('security.session.revoked', '/api/security/sessions/revoke', 'POST', { session_id: f.accounts.get('owner').sessionId }, 'SELECT id FROM gameops_admin_sessions WHERE id=$1', [f.accounts.get('owner').sessionId]);
    await rollbackCase('virtual_wallet.credit', '/api/admin/virtual-wallets/' + p1 + '/adjust', 'POST', { action: 'credit', amount: 50, note: 'Rollback audit', idempotency_key: crypto.randomUUID() }, 'SELECT * FROM gameops_virtual_wallet_accounts WHERE player_id=$1', [p1]);
    assert.equal((await req('/api/admin/summary')).status, 200, 'Failed self-session revoke must retain the original session');
    await pool.query('DROP TRIGGER cp14_audit_fault ON gameops_audit');
    return { mutationsTested: 18, businessRowsUnchangedOnAuditFailure: true, auditRowsUnchangedOnFailure: true, walletRollbackRetained: true };
  });
  await check('C02', 'accepted settings and same-slug content survive restart without destructive migration', async () => {
    const before = await pool.query('SELECT id,kind,slug,title,body,version FROM gameops_content ORDER BY id');
    const settingsBefore = await pool.query('SELECT * FROM gameops_settings ORDER BY key');
    await f.stop(); assert.equal((await f.start()).version, '0.14.0');
    assert.deepEqual((await pool.query('SELECT id,kind,slug,title,body,version FROM gameops_content ORDER BY id')).rows, before.rows);
    assert.deepEqual((await pool.query('SELECT * FROM gameops_settings ORDER BY key')).rows, settingsBefore.rows);
    assert.equal((await req('/info/page/shared-privacy', 'GET', undefined, null)).status, 200);
    assert.equal((await req('/info/policy/shared-privacy', 'GET', undefined, null)).status, 200);
    return { existingContentPreserved: true, settingsPreserved: true, additiveMigrationsIdempotent: true };
  });
});
