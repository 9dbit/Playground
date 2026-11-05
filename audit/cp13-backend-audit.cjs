'use strict';
// CP13 diagnostic only. Runs the REAL server.js against an ephemeral localhost
// PostgreSQL schema. Does not repair findings or access any production service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const bridge = require('../engine/game-bridge');
const BASE = '3e9dad5f010aa830ba4930d1d85cd793c25deb2c';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'audit-results');
const EXPECTED = {
  'server.js': 'e052081e367a584af9a6c819f94bbdf909a05a72',
  'engine/deep-routes.js': '9b91bee93f7260f8883c16c3ff5ed2b6f384faa8',
  'engine/security.js': '5ed97e312c9c335592f17976f82b8824fea83c56',
  'engine/security-policy.js': '458ee898f954a47d928a4f296966fcbdf1e49e37',
  'engine/virtual-wallet.js': 'cceeb5e56c1db95c9e877bc46fb1ab071bf746db',
  'engine/game-bridge.js': '076ce12ff8b2f1ea1ea8aac9e52001efc96163f6',
  'engine/admin-operations.js': 'ad1e54fd925e668d2a7d0491028323937847f6d4'
};
const report = { audit: 'Playground CP13 backend source + full-server regression audit',
  baseline: BASE, startedAt: new Date().toISOString(), mode: 'diagnostic_only',
  productionContacted: false, productionModified: false, backendSourceModified: false,
  checks: [], findings: [], integrationGaps: [], harnessErrors: [] };
let appProcess, rootPool, pool, schema, baseUrl;
let runtimeLog = '';
const credentials = new Map();
const actors = ['audit_owner', 'audit_operator', 'audit_support', 'audit_viewer'];
const gid = 'aaaaaaaa-1111-4111-8111-111111111111';
const otherGame = 'bbbbbbbb-2222-4222-8222-222222222222';
const p1 = 'abcdefab-1111-4111-8111-111111111111';
const p2 = 'bcdefabc-2222-4222-8222-222222222222';
const pOther = 'cdefabcd-3333-4333-8333-333333333333';
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function blobSha(bytes) { return crypto.createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex'); }
function invariant(test, message) { assert.ok(test, message); }
async function check(id, title, fn) {
  try { const evidence = await fn(); report.checks.push({ id, title, status: 'PASS', evidence }); }
  catch (e) { report.harnessErrors.push({ id, title, error: e.message }); }
}
async function finding(id, priority, title, source, expected, fn) {
  try {
    const evidence = await fn();
    report.findings.push({ id, priority, title, status: 'REPRODUCED', source, expected, evidence });
  } catch (e) { report.harnessErrors.push({ id, title, error: e.message }); }
}
async function request(endpoint, method = 'GET', body, actor = 'audit_owner', extra = {}) {
  const account = actor && credentials.get(actor);
  const headers = { Origin: baseUrl, ...(account ? { Cookie: account.cookie, 'X-CSRF-Token': account.csrf } : {}), ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(baseUrl + endpoint, { method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { status: response.status, data, text, byteLength: bytes.length };
}
function auditAction(action, on = true) {
  return on ? pool.query('INSERT INTO cp13_fault_actions(action) VALUES($1) ON CONFLICT DO NOTHING', [action])
    : pool.query('DELETE FROM cp13_fault_actions WHERE action=$1', [action]);
}
async function ephemeralPort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  const dburl = new URL(process.env.TEST_DATABASE_URL || 'http://invalid');
  invariant(['postgres:', 'postgresql:'].includes(dburl.protocol), 'TEST_DATABASE_URL must be Postgres');
  invariant(['localhost', '127.0.0.1', '[::1]'].includes(dburl.hostname), 'Audit refuses non-localhost databases');
  invariant(dburl.pathname === '/gameops_ci', 'Audit requires the dedicated ephemeral gameops_ci database');
  invariant(process.env.CI === 'true', 'Full-server audit runs only in isolated CI');
  fs.mkdirSync(OUT, { recursive: true });
  report.sourceHashes = Object.entries(EXPECTED).map(([name, expected]) => {
    const bytes = fs.readFileSync(path.join(ROOT, name));
    const actual = blobSha(bytes); invariant(actual === expected, 'Source drift detected: ' + name);
    const output = path.join(OUT, 'inspected-source', name);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes);
    return { file: name, blob: actual };
  });
  report.runtime = { node: process.version, express: require('express/package.json').version, pg: require('pg/package.json').version };
  const routeInventory = [];
  for (const name of Object.keys(EXPECTED)) {
    const src = fs.readFileSync(path.join(ROOT, name), 'utf8');
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      routeInventory.push({ file: name, method: m[1].toUpperCase(), path: m[2], line: src.slice(0, m.index).split('\n').length });
    }
  }
  report.routeInventory = { literalRegistrations: routeInventory.length,
    duplicates: routeInventory.filter((x, i) => routeInventory.some((y, j) => j < i && y.method === x.method && y.path.replace(/:[^/]+/g, ':param') === x.path.replace(/:[^/]+/g, ':param'))) };
  fs.writeFileSync(path.join(OUT, 'route-inventory.json'), JSON.stringify(routeInventory, null, 2));
  rootPool = new Pool({ connectionString: dburl.toString() });
  schema = 'cp13_audit_' + crypto.randomBytes(8).toString('hex');
  await rootPool.query('CREATE SCHEMA ' + schema);
  dburl.searchParams.set('options', '-c search_path=' + schema + ',public');
  pool = new Pool({ connectionString: dburl.toString() });
  const port = await ephemeralPort(); baseUrl = 'http://127.0.0.1:' + port;
  const master = crypto.randomBytes(48).toString('hex');
  const bootstrapPassword = crypto.randomBytes(32).toString('base64url');
  const bridgeKey = { id: 'audit-cp13-key', game: 'skygate-5000', secret: crypto.randomBytes(32).toString('hex'), environment: 'staging', allowRounds: true };
  appProcess = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env,
    DATABASE_URL: dburl.toString(), SESSION_SECRET: master, ADMIN_USERNAME: 'audit_owner', ADMIN_PASSWORD: bootstrapPassword,
    PUBLIC_SITE_URL: baseUrl, RAILWAY_PUBLIC_DOMAIN: '', NODE_ENV: 'test', PORT: String(port),
    GAMEOPS_BRIDGE_KEYS: JSON.stringify([bridgeKey]), DEV_ACCESS_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  appProcess.stdout.on('data', x => { runtimeLog += x.toString(); });
  appProcess.stderr.on('data', x => { runtimeLog += x.toString(); });
  let ready = false;
  for (let i = 0; i < 160; i++) {
    if (appProcess.exitCode !== null) throw Error('Fixture server exited during initialization: ' + runtimeLog.slice(-1000));
    try { const r = await request('/health', 'GET', undefined, null); if (r.status === 200) { report.health = r.data; ready = true; break; } } catch {}
    await delay(150);
  }
  invariant(ready, 'Fixture server did not become healthy');
  invariant(report.health.version === '0.12.0', 'Unexpected server release');
  // Only the disposable CI database is seeded. No MFA or session state in production is changed.
  const owner = (await pool.query("UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='audit_owner' RETURNING id,password_hash")).rows[0];
  for (let i = 0; i < actors.length; i++) {
    const role = ['owner', 'operator', 'support', 'viewer'][i]; const username = actors[i];
    const id = i === 0 ? owner.id : (await pool.query("INSERT INTO gameops_admin_accounts(username,display_name,role,password_hash,must_change_password,mfa_enabled) VALUES($1,$1,$2,$3,false,true) RETURNING id", [username, role, owner.password_hash])).rows[0].id;
    const raw = crypto.randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '1 hour')", [id, hash(raw)]);
    credentials.set(username, { id, cookie: 'gameops_session=' + raw,
      csrf: crypto.createHmac('sha256', master).update('cp08:csrf:' + raw).digest('base64url') });
  }
  await pool.query('INSERT INTO gameops_games(id,name,slug,code,platform) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$9,$10)',
    [gid, 'Audit Main Game', 'cp13-main', 'AUD', 'Web', otherGame, 'Audit Other Game', 'cp13-other', 'A2', 'Web']);
  await pool.query('INSERT INTO gameops_players(id,game_id,player_ref) VALUES($1,$2,$3),($4,$2,$5),($6,$7,$8)',
    [p1, gid, 'audit-player-one', p2, 'audit-player-two', pOther, otherGame, 'other-player']);
  for (let i = 0; i < 8; i++) await pool.query('INSERT INTO gameops_events(event_id,game_id,round_id,player_ref,stake,payout,occurred_at) VALUES($1,$2,$3,$4,100,$5,now())',
    ['audit-event-' + i, gid, 'audit-round-' + i, i % 2 ? 'audit-player-two' : 'audit-player-one', i % 2 ? 150 : 0]);
  const serverPrefix = '/api/admin';
  await check('C01', 'Anonymous APIs, CSRF and server-side roles', async () => {
    const anonymous = await request(serverPrefix + '/summary', 'GET', undefined, null);
    const missingCsrf = await request(serverPrefix + '/settings/general', 'PUT', { value: { site_title: 'Blocked' } }, 'audit_owner', { 'X-CSRF-Token': '' });
    const viewerWrite = await request(serverPrefix + '/virtual-wallets/' + p1 + '/adjust', 'POST', { action: 'credit', amount: 100, note: 'Audit role test', idempotency_key: crypto.randomUUID() }, 'audit_viewer');
    const supportSettings = await request(serverPrefix + '/settings/general', 'PUT', { value: { site_title: 'Blocked' } }, 'audit_support');
    assert.deepEqual([anonymous.status, missingCsrf.status, viewerWrite.status, supportSettings.status], [401, 403, 403, 403]);
    return { anonymous: 401, missingCsrf: 403, viewerWalletWrite: 403, supportSettingsWrite: 403 };
  });
  let gameConfig;
  await check('C02', 'Canonical UUID and persisted demo configuration', async () => {
    const r = await request(serverPrefix + '/deep/games/' + gid); assert.equal(r.status, 200);
    gameConfig = { name: 'Audit Main Game', code: 'AUD', platform: 'Web', demo_chance: 20, winning_chance: 65, win_amount: 35,
      invest_enabled: false, min_invest: 1, max_invest: 1000, trending: false, featured: false, instructions: 'Audit metadata only', version: r.data.item.version };
    const saved = await request(serverPrefix + '/deep/games/' + gid, 'PUT', gameConfig); assert.equal(saved.status, 200);
    const readback = await request(serverPrefix + '/deep/games/' + gid); assert.equal(readback.data.item.winning_chance, 65); assert.equal(readback.data.item.win_amount, 35);
    const stale = await request(serverPrefix + '/deep/games/' + gid, 'PUT', gameConfig); assert.equal(stale.status, 409);
    gameConfig.version = readback.data.item.version;
    return { validUuid: 200, readback: [65, 35], staleWrite: 409, externalEngineAffected: saved.data.externalEngineAffected };
  });
  await check('C03', 'Player-round scoping and real pagination', async () => {
    const r = await request(serverPrefix + '/deep/players/' + p1 + '/rounds?limit=1&page=1');
    assert.equal(r.status, 200); assert.equal(r.data.total, 4); assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].player_ref, 'audit-player-one');
    return { total: r.data.total, pageRows: r.data.items.length, scoped: true };
  });
  await finding('F01', 'P1', 'Old server route shadows CP12 filtered game log', ['server.js', 'engine/deep-routes.js'], 'The real server must honor result/limit/page and return page metadata.', async () => {
    const r = await request(serverPrefix + '/deep/games/' + gid + '/rounds?result=win&limit=1&page=2');
    assert.equal(r.status, 200); assert.equal(r.data.items.length, 8); invariant(r.data.total === undefined, 'Shadow route not reproduced');
    return { response: 200, requested: { result: 'win', limit: 1, page: 2 }, returnedRows: r.data.items.length,
      returnedPayouts: [...new Set(r.data.items.map(x => x.payout))], paginationMetadata: false };
  });
  await finding('F02', 'P2', 'System Settings accepts invalid field types and values', ['server.js'], 'Each module must validate keys, types, ranges and effective runtime support.', async () => {
    const invalid = { timezone: 'Not/AZone', per_page: -10, register_bonus: -500, transfer_percent: 101, base_color: 'not-a-color' };
    const r = await request(serverPrefix + '/settings/general', 'PUT', { value: invalid }); assert.equal(r.status, 200);
    const stored = (await pool.query("SELECT value FROM gameops_settings WHERE key='general'")).rows[0].value;
    assert.equal(stored.register_bonus, -500);
    return { response: 200, storedInvalidValues: stored, unauthorizedAccess: false };
  });
  await finding('F03', 'P2', 'System Settings ignores stale version and overwrites newer data', ['server.js'], 'A stale version must be rejected rather than silently replacing a newer save.', async () => {
    const old = (await pool.query("SELECT version FROM gameops_settings WHERE key='general'")).rows[0].version;
    const first = await request(serverPrefix + '/settings/general', 'PUT', { version: old, value: { site_title: 'Writer A' } });
    const second = await request(serverPrefix + '/settings/general', 'PUT', { version: old, value: { site_title: 'Stale Writer B' } });
    const row = (await pool.query("SELECT version,value FROM gameops_settings WHERE key='general'")).rows[0];
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(row.value.site_title, 'Stale Writer B');
    return { bothUsedVersion: old, responses: [first.status, second.status], finalVersion: row.version, finalTitle: row.value.site_title };
  });
  await pool.query('CREATE TABLE cp13_fault_actions(action text PRIMARY KEY)');
  await pool.query("CREATE FUNCTION cp13_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM cp13_fault_actions WHERE action=NEW.action) THEN RAISE EXCEPTION 'CP13_INJECTED_AUDIT_FAILURE'; END IF; RETURN NEW; END; $$");
  await pool.query('CREATE TRIGGER cp13_audit_fault BEFORE INSERT ON gameops_audit FOR EACH ROW EXECUTE FUNCTION cp13_fault()');
  await finding('F04', 'P1', 'Business writes commit even when audit write fails', ['server.js', 'engine/deep-routes.js', 'engine/admin-operations.js'], 'Business write and audit must succeed or roll back together.', async () => {
    await auditAction('game.config.updated');
    const failedGame = await request(serverPrefix + '/deep/games/' + gid, 'PUT', { ...gameConfig, name: 'Saved despite failed audit' });
    await auditAction('game.config.updated', false);
    const gameAfter = (await pool.query('SELECT name FROM gameops_games WHERE id=$1', [gid])).rows[0];
    await auditAction('settings.saved');
    const failedSetting = await request(serverPrefix + '/settings/general', 'PUT', { value: { site_title: 'Saved despite audit failure' } });
    await auditAction('settings.saved', false);
    const settingAfter = (await pool.query("SELECT value FROM gameops_settings WHERE key='general'")).rows[0];
    await auditAction('admin.profile.updated');
    const failedProfile = await request(serverPrefix + '/ops/profile', 'PUT', { displayName: 'Saved despite audit failure' });
    await auditAction('admin.profile.updated', false);
    const profileAfter = (await pool.query('SELECT display_name FROM gameops_admin_accounts WHERE id=$1', [owner.id])).rows[0];
    assert.deepEqual([failedGame.status, failedSetting.status, failedProfile.status], [500, 500, 500]);
    assert.equal(gameAfter.name, 'Saved despite failed audit'); assert.equal(settingAfter.value.site_title, 'Saved despite audit failure'); assert.equal(profileAfter.display_name, 'Saved despite audit failure');
    return { fault: 'Synthetic PostgreSQL audit-insert failure in isolated schema only',
      responses: [500, 500, 500], writesStillCommitted: ['game configuration', 'general settings', 'own profile'] };
  });
  await check('C04', 'Virtual wallet idempotency, atomicity and overdraft defense', async () => {
    const endpoint = serverPrefix + '/virtual-wallets/' + p1 + '/adjust';
    const body = { action: 'credit', amount: 100, note: 'CP13 audit-only virtual credit', idempotency_key: crypto.randomUUID() };
    const credit = await request(endpoint, 'POST', body); assert.equal(credit.status, 200);
    const replay = await request(endpoint, 'POST', body); assert.equal(replay.status, 200); assert.equal(replay.data.replay, true);
    await auditAction('virtual_wallet.credit');
    const rolled = await request(endpoint, 'POST', { ...body, amount: 75, idempotency_key: crypto.randomUUID() });
    await auditAction('virtual_wallet.credit', false); assert.equal(rolled.status, 500);
    const after = await request(serverPrefix + '/virtual-wallets/' + p1); assert.equal(after.data.balance, '100');
    const bad = await request(endpoint, 'POST', { ...body, action: 'debit', amount: 101, idempotency_key: crypto.randomUUID() }); assert.equal(bad.status, 409);
    const transfer = await request(serverPrefix + '/virtual-wallets/' + p1 + '/transfer', 'POST', { to_player_id: p2, amount: 25, note: 'CP13 same-game transfer fixture', idempotency_key: crypto.randomUUID() });
    assert.equal(transfer.status, 200); assert.equal(transfer.data.fromBalance, '75'); assert.equal(transfer.data.toBalance, '25');
    const sum = (await pool.query('SELECT sum(delta)::text AS total FROM gameops_virtual_wallet_entries WHERE operation_id=$1', [transfer.data.operationId])).rows[0].total;
    assert.equal(sum, '0');
    return { originalBalance: '100', replayNoDoubleCredit: true, auditFailureRollsBack: true, overdraft: 409, transferConserved: true };
  });
  await finding('F05', 'P1', 'Banned-user filter runs after LIMIT 200 and hides older matching users', ['engine/deep-routes.js'], 'Filtering must occur in SQL before pagination.', async () => {
    await pool.query("UPDATE gameops_players SET last_seen=now()-interval '90 days' WHERE id=$1", [p2]);
    await pool.query("INSERT INTO gameops_player_profiles(player_id,local_status) VALUES($1,'blocked_locally') ON CONFLICT(player_id) DO UPDATE SET local_status='blocked_locally'", [p2]);
    await pool.query("INSERT INTO gameops_players(game_id,player_ref,last_seen) SELECT $1,'cp13-recent-'||n,now() FROM generate_series(1,205) n", [gid]);
    const r = await request(serverPrefix + '/deep/players?state=banned'); assert.equal(r.status, 200); assert.equal(r.data.items.length, 0);
    const actual = (await pool.query("SELECT count(*)::int AS n FROM gameops_player_profiles WHERE local_status='blocked_locally'")).rows[0].n; assert.equal(actual, 1);
    return { recentOtherUsers: 205, matchingRowsInDatabase: actual, returnedMatchingRows: 0 };
  });
  await finding('F06', 'P2', 'Support replies always record author as admin', ['engine/deep-routes.js'], 'Reply author should match the authenticated administrator.', async () => {
    const ticket = await request(serverPrefix + '/tickets', 'POST', { subject: 'CP13 author attribution', requester_ref: 'audit-fixture', priority: 'Low' }, 'audit_support');
    assert.equal(ticket.status, 201);
    const tid = ticket.data.item.id;
    const sent = await request(serverPrefix + '/deep/tickets/' + tid + '/replies', 'POST', { body: 'Reply from the audit support account' }, 'audit_support'); assert.equal(sent.status, 201);
    const messages = await request(serverPrefix + '/deep/tickets/' + tid, 'GET', undefined, 'audit_support');
    assert.equal(messages.data.messages.at(-1).author, 'admin');
    return { authenticatedActor: 'audit_support', messageAuthor: messages.data.messages.at(-1).author, externalDelivery: false };
  });
  await finding('F07', 'P2', 'Public page/policy URLs can collide on the same slug', ['engine/deep-routes.js'], 'Published content sharing one /info/:slug namespace needs a unique canonical URL.', async () => {
    const slug = 'cp13-shared-url';
    const page = await request(serverPrefix + '/deep/content/page', 'POST', { slug, title: 'Audit Public Page', body: 'Synthetic page body', status: 'published' });
    const policy = await request(serverPrefix + '/deep/content/policy', 'POST', { slug, title: 'Audit Policy', body: 'Synthetic policy body', status: 'published' });
    assert.deepEqual([page.status, policy.status], [201, 201]);
    const rows = (await pool.query("SELECT kind FROM gameops_content WHERE slug=$1 AND status='published'", [slug])).rows;
    const publicPage = await request('/info/' + slug, 'GET', undefined, null); assert.equal(publicPage.status, 200); assert.equal(rows.length, 2);
    const sitemap = await request('/sitemap.xml', 'GET', undefined, null);
    const hits = sitemap.text.split('/info/' + slug).length - 1; assert.equal(hits, 2);
    return { creationStatuses: [201, 201], publishedRecordsForOneUrl: rows.length, duplicateSitemapLocations: hits };
  });
  await finding('F08', 'P2', 'Artwork upload accepts a two-byte truncated JPEG', ['engine/deep-routes.js'], 'A stored image must decode as a complete bounded image, not only match magic bytes.', async () => {
    const truncated = Buffer.from([0xff, 0xd8]);
    const r = await request(serverPrefix + '/deep/games/' + gid + '/image', 'POST', { data: 'data:image/jpeg;base64,' + truncated.toString('base64') }); assert.equal(r.status, 200);
    const row = (await pool.query('SELECT octet_length(image_bytes)::int AS bytes FROM gameops_game_profiles WHERE game_id=$1', [gid])).rows[0];
    assert.equal(row.bytes, 2);
    return { response: 200, storedByteCount: 2, validDecodableImage: false, codeExecutionClaim: false };
  });
  await check('C08', 'Noncanonical wallet UUID is denied before mutation', async () => {
    const r = await request(serverPrefix + '/virtual-wallets/' + p1.toUpperCase() + '/adjust', 'POST', { action: 'credit', amount: 1, note: 'CP13 uppercase UUID fixture', idempotency_key: crypto.randomUUID() });
    assert.equal(r.status, 403);
    const after = await request(serverPrefix + '/virtual-wallets/' + p1); assert.equal(after.data.balance, '75');
    return { uppercaseUuidStatus: r.status, normalLookupStatus: after.status, balanceUnchanged: true };
  });
  await check('C05', 'Legacy ingest rejected and unsigned bridge requests refused', async () => {
    const old = await request('/api/v1/game-events', 'POST', {}, null);
    const unsigned = await request('/api/v2/game-bridge', 'POST', {}, null);
    assert.equal(old.status, 410); assert.equal(unsigned.status, 401);
    return { legacy: 410, unsignedBridge: 401 };
  });
  await check('C06', 'A signed round is visible only in its intended observational bridge', async () => {
    const before = await request(serverPrefix + '/summary');
    const payload = { schema_version: 2, game: 'skygate-5000', environment: 'staging', type: 'round.settled',
      event_id: 'cp13-synthetic-event', round_id: 'cp13-synthetic-round', player_ref: 'p_' + 'a'.repeat(64), currency: 'DEMO_COIN',
      stake: '0.100000000001', payout: '0.200000000002', occurred_at: new Date().toISOString() };
    const body = Buffer.from(JSON.stringify(payload)), timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(16).toString('hex');
    const response = await fetch(baseUrl + bridge.PATH, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'x-gameops-key': bridgeKey.id, 'x-gameops-timestamp': timestamp, 'x-gameops-nonce': nonce,
      'x-gameops-signature': bridge.signature(bridgeKey.secret, timestamp, nonce, body) }, body });
    const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.accepted, true);
    const observed = await request(serverPrefix + '/bridge/skygate-5000/rounds'); assert.equal(observed.data.items.length, 1);
    assert.equal(observed.data.items[0].stake, '0.100000000001');
    const after = await request(serverPrefix + '/summary'); assert.equal(after.data.rounds, before.data.rounds);
    report.integrationGaps.push({ id: 'G01', status: 'OBSERVED_SEPARATION', title: 'Bridge rounds are not reconciled into legacy dashboard/player counters',
      evidence: { bridgeAcceptedRounds: 1, dashboardBefore: before.data.rounds, dashboardAfter: after.data.rounds },
      note: 'Deliberate observational design, not loss of the accepted event. Full platform integration is still incomplete.' });
    return { accepted: true, exactDecimalRetained: true, writesToLegacyDashboard: false, noWalletSettlement: true };
  });
  await check('C07', 'Display-name update applies only to the authenticated account', async () => {
    const r = await request(serverPrefix + '/ops/profile', 'PUT', { displayName: 'Own display', id: owner.id, role: 'owner' }, 'audit_viewer');
    assert.equal(r.status, 200);
    const me = await request(serverPrefix + '/ops/profile', 'GET', undefined, 'audit_viewer'); assert.equal(me.data.item.role, 'viewer');
    const ownerAfter = (await pool.query('SELECT display_name FROM gameops_admin_accounts WHERE id=$1', [owner.id])).rows[0];
    assert.equal(ownerAfter.display_name, 'Saved despite audit failure');
    return { viewerRoleRemains: 'viewer', ownerProfileNotChanged: true };
  });
}
async function finalize() {
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill('SIGTERM');
    await Promise.race([new Promise(resolve => appProcess.once('exit', resolve)), delay(4000)]);
    if (appProcess.exitCode === null) appProcess.kill('SIGKILL');
  }
  if (pool) await pool.end().catch(() => {});
  if (rootPool && schema) await rootPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(e => report.harnessErrors.push({ id: 'CLEANUP', error: e.message }));
  if (rootPool) await rootPool.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.summary = { controlsPassed: report.checks.length, defectsReproduced: report.findings.length,
    integrationGapsObserved: report.integrationGaps.length, harnessErrors: report.harnessErrors.length,
    result: report.harnessErrors.length ? 'HARNESS_ERROR' : 'AUDIT_COMPLETE_WITH_OPEN_FINDINGS' };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'CP13_BACKEND_AUDIT.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'fixture-server.log'), runtimeLog);
  console.log('CP13_AUDIT_SUMMARY ' + JSON.stringify(report.summary));
  for (const f of report.findings) console.log('CP13_FINDING ' + JSON.stringify({ id: f.id, priority: f.priority, title: f.title, evidence: f.evidence }));
  for (const e of report.harnessErrors) console.error('CP13_HARNESS_ERROR ' + JSON.stringify(e));
  // A green diagnostic job means reproducible evidence was collected, not that
  // the product passed audit. Open findings are intentionally retained.
  if (report.harnessErrors.length) process.exitCode = 1;
}
main().catch(e => report.harnessErrors.push({ id: 'SETUP', error: e.message })).finally(finalize);
