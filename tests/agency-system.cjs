"use strict";
const assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  path = require("node:path");
const { Pool: NativePool } = require("pg");
const C = require("../engine/security-crypto");
const { calculate } = require("../engine/agency/billing");
const secret = crypto.randomBytes(48).toString("hex"),
  password = crypto.randomBytes(24).toString("base64url"),
  gameSecret = crypto.randomBytes(32).toString("hex");
const report = {
  mode: process.env.TEST_DATABASE_URL ? "native-postgresql" : "postgresql-wasm",
  productionContacted: false,
  checks: [],
  failures: [],
  startedAt: new Date().toISOString(),
};
const creds = new Map();
let server, app, pool, runtime, rootPool, schema, base;
async function check(id, title, fn) {
  try {
    const evidence = await fn();
    report.checks.push({ id, title, status: "PASS", evidence });
    console.log("AG_PASS", id, title);
  } catch (e) {
    report.failures.push({ id, title, error: e.message });
    console.error("AG_FAIL", id, e.stack);
  }
}
async function req(endpoint, method = "GET", body, who = "master", extra = {}) {
  const a = creds.get(who),
    headers = {
      Origin: base,
      ...(a ? { Cookie: a.cookie, "X-CSRF-Token": a.csrf } : {}),
      ...extra,
    };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (extra.Host) {
    const out = await new Promise((resolve, reject) => {
      const q = require("node:http").request(
        base + endpoint,
        { method, headers },
        (r) => {
          let text = "";
          r.setEncoding("utf8");
          r.on("data", (x) => (text += x));
          r.on("end", () => {
            let data = null;
            try {
              data = JSON.parse(text);
            } catch {}
            resolve({
              status: r.statusCode,
              data,
              text,
              headers: new Headers(r.headers),
            });
          });
        },
      );
      q.setTimeout(30000, () => q.destroy(new Error("HTTP timeout")));
      q.on("error", reject);
      q.end(body === undefined ? undefined : JSON.stringify(body));
    });
    return out;
  }
  const r = await fetch(base + endpoint, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: r.status, data, text, headers: r.headers };
}
async function ok(endpoint, method = "GET", body, who = "master") {
  const r = await req(endpoint, method, body, who);
  assert.ok(
    r.status >= 200 && r.status < 300,
    endpoint + " " + r.status + " " + JSON.stringify(r.data),
  );
  return r.data;
}
async function staff(t, role, label) {
  const username = "qa_" + label,
    hash = await C.passwordHash(password),
    mfa = C.base32(crypto.randomBytes(20));
  const a = (
    await pool.query(
      "INSERT INTO agency_staff(tenant_id,username,display_name,password_hash,role,mfa_enabled) VALUES($1,$2,$2,$3,$4,true) RETURNING *",
      [t, username, hash, role],
    )
  ).rows[0];
  await pool.query("UPDATE agency_staff SET mfa_secret=$2 WHERE id=$1", [
    a.id,
    C.encryption(secret).seal(mfa, a.id),
  ]);
  const raw = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO agency_sessions(tenant_id,staff_id,token_hash,auth_version,ip,user_agent,expires_at) VALUES($1,$2,$3,1,'127.0.0.1','QA',now()+interval '1 hour')",
    [t, a.id, C.sha(raw)],
  );
  creds.set(label, {
    id: a.id,
    tenant: t,
    mfa,
    cookie: "agency_staff=" + raw,
    csrf: crypto
      .createHmac("sha256", secret)
      .update("agency:csrf:" + raw)
      .digest("base64url"),
  });
  return a;
}
async function player(t, label) {
  const r = await req(
    "/api/player/auth/register",
    "POST",
    {
      tenant: t.slug,
      username: "player_" + label,
      password,
      display_name: "Synthetic " + label,
    },
    null,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  creds.set(label, {
    id: r.data.id,
    tenant: t.id,
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: r.data.csrf,
  });
  return r.data;
}
const masterPath = (t) => "/api/admin/agency/tenants/" + t;
async function topup(t, n) {
  const a = await ok(masterPath(t) + "/coins", "POST", {
    amount: String(n),
    reason: "Synthetic test allocation",
  });
  await ok(masterPath(t) + "/coins/" + a.id + "/review", "POST", {
    decision: "approve",
  });
}
async function fund(t, n, target = "withdraw") {
  await ok(masterPath(t) + "/simulation/fund", "POST", {
    amount: String(n),
    target,
    idempotency_key: crypto.randomUUID(),
  });
}
async function paid(t, p, n, method = "qris") {
  const d = await ok(
    "/api/player/deposits",
    "POST",
    { amount: String(n), method, idempotency_key: crypto.randomUUID() },
    p,
  );
  return ok(masterPath(t) + "/simulation/payment/" + d.id, "POST", {
    amount: String(n),
    reference: "event:" + d.id,
  });
}
async function factorToken(who, action, resource, payload) {
  const a = creds.get(who);
  const code = C.totp(a.mfa, Math.floor(Date.now() / 30000));
  const grant = await ok(
    "/api/agency/step-up",
    "POST",
    { action, resource, payload, password, code },
    who,
  );
  return { approval_token: grant.approval_token };
}
async function game(action, body) {
  const route = "/api/v4/agency-game/" + action,
    ts = String(Math.floor(Date.now() / 1000)),
    nonce = crypto.randomBytes(16).toString("hex");
  const sig = crypto
    .createHmac("sha256", gameSecret)
    .update(
      ["agency.v1", "POST", route, ts, nonce, C.sha(JSON.stringify(body))].join(
        "\n",
      ),
    )
    .digest("hex");
  return req(route, "POST", body, null, {
    "X-Agency-Key": "qa-uno",
    "X-Agency-Timestamp": ts,
    "X-Agency-Nonce": nonce,
    "X-Agency-Signature": sig,
  });
}
async function main() {
  let dbUrl = process.env.TEST_DATABASE_URL;
  if (dbUrl) {
    const u = new URL(dbUrl);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
      "Tests require disposable localhost PostgreSQL",
    );
    assert.equal(u.pathname, "/gameops_ci");
    rootPool = new NativePool({ connectionString: dbUrl });
    schema = "agency_" + crypto.randomBytes(8).toString("hex");
    await rootPool.query("CREATE SCHEMA " + schema);
    u.searchParams.set("options", "-c search_path=" + schema + ",public");
    dbUrl = u.toString();
  } else {
    require.cache[require.resolve("pg")] = {
      exports: require("./helpers/pglite-pool.cjs"),
    };
    dbUrl = "postgresql://localhost/gameops_ci";
  }
  const probe = require("node:net").createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  base = "http://127.0.0.1:" + port;
  Object.assign(process.env, {
    DATABASE_URL: dbUrl,
    SESSION_SECRET: secret,
    ADMIN_USERNAME: "qa_master",
    ADMIN_PASSWORD: password,
    NODE_ENV: "test",
    PORT: String(port),
    PUBLIC_SITE_URL: base,
    GAMEOPS_BRIDGE_KEYS: "[]",
    AGENCY_GAME_KEYS: JSON.stringify([
      {
        id: "qa-uno",
        game: "uno-luck",
        secret: gameSecret,
        environment: "sandbox",
      },
    ]),
  });
  runtime = require("../server");
  ({ app, pool } = runtime);
  await runtime.initDB();
  server = app.listen(port, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const owner = (
    await pool.query(
      "UPDATE gameops_admin_accounts SET must_change_password=false,mfa_enabled=true WHERE username='qa_master' RETURNING id",
    )
  ).rows[0];
  const raw = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO gameops_admin_sessions(admin_id,token_hash,auth_version,mfa_verified,expires_at) VALUES($1,$2,1,true,now()+interval '1 hour')",
    [owner.id, C.sha(raw)],
  );
  creds.set("master", {
    id: owner.id,
    cookie: "gameops_session=" + raw,
    csrf: crypto
      .createHmac("sha256", secret)
      .update("cp08:csrf:" + raw)
      .digest("base64url"),
  });
  const A = (
    await ok("/api/admin/agency/tenants", "POST", {
      name: "Alpha QA",
      slug: "alpha-qa",
      owner_username: "alpha_owner",
      owner_password: password,
      fee_basis: "net",
      account_mode: "SHARED",
    })
  ).tenant;
  const B = (
    await ok("/api/admin/agency/tenants", "POST", {
      name: "Beta QA",
      slug: "beta-qa",
      owner_username: "beta_owner",
      owner_password: password,
      fee_basis: "gross",
      account_mode: "SPLIT",
    })
  ).tenant;
  await staff(A.id, "owner", "ownerA");
  await staff(A.id, "finance", "financeA");
  await staff(A.id, "supervisor", "superA");
  await staff(A.id, "supervisor", "superA2");
  await staff(A.id, "marketing", "marketingA");
  await staff(B.id, "owner", "ownerB");
  const PA = await player(A, "playerA"),
    PB = await player(B, "playerB");
  await topup(A.id, 5000000);
  await topup(B.id, 3000000);
  await fund(A.id, 3000000);
  await fund(B.id, 100000, "deposit");
  await fund(A.id, 100000, "risk");
  let dep, manual, wd, late;
  await check(
    "T01",
    "Two tenant reads, guessed IDs and global APIs are isolated",
    async () => {
      dep = await paid(A.id, "playerA", 2000000);
      const bdep = await paid(B.id, "playerB", 200000);
      assert.equal(
        (
          await req(
            "/api/agency/transactions/" + bdep.id,
            "GET",
            undefined,
            "financeA",
          )
        ).status,
        404,
      );
      assert.equal(
        (await req("/api/admin/games", "GET", undefined, "ownerA")).status,
        401,
      );
      const w = await ok("/api/player/wallet", "GET", undefined, "playerB");
      assert.ok(w.transactions.every((x) => x.tenant_id === B.id));
      return { crossTenant: 404, masterApi: 401 };
    },
  );
  await check(
    "T02",
    "Permission and CSRF are enforced server-side",
    async () => {
      assert.equal(
        (await req("/api/agency/transactions", "GET", undefined, "marketingA"))
          .status,
        403,
      );
      assert.equal(
        (await req("/api/agency/staff", "GET", undefined, "financeA")).status,
        403,
      );
      const r = await req(
        "/api/player/deposits",
        "POST",
        { amount: "1", method: "qris", idempotency_key: crypto.randomUUID() },
        "playerA",
        { "X-CSRF-Token": "wrong" },
      );
      assert.equal(r.status, 403);
    },
  );
  await check(
    "T03",
    "Paid deposit consumes stock and credits once, duplicate/conflict detected",
    async () => {
      const same = await ok(
        masterPath(A.id) + "/simulation/payment/" + dep.id,
        "POST",
        { amount: dep.amount, reference: "event:" + dep.id },
      );
      assert.equal(same.state, "credited");
      const c = (
        await pool.query(
          "SELECT count(*)::int AS n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
          [A.id, "sale:" + dep.id],
        )
      ).rows[0].n;
      assert.equal(c, 1);
      assert.equal(
        (
          await req(
            masterPath(A.id) + "/simulation/payment/" + dep.id,
            "POST",
            { amount: "1", reference: "event:" + dep.id },
          )
        ).status,
        409,
      );
      return { credits: c };
    },
  );
  await check(
    "T04",
    "Confirmed deposit is pending cash until provider settlement",
    async () => {
      let a = await runtime.overview?.(A.id);
      const cash = (
        await pool.query(
          "SELECT amount::text FROM agency_balances WHERE tenant_id=$1 AND code='cash:deposit_pending'",
          [A.id],
        )
      ).rows[0];
      assert.equal(cash.amount, "2000000");
      await ok(
        masterPath(A.id) + "/simulation/settlement/" + dep.id,
        "POST",
        {},
      );
      assert.equal(
        (
          await pool.query(
            "SELECT amount::text FROM agency_balances WHERE tenant_id=$1 AND code='cash:deposit_pending'",
            [A.id],
          )
        ).rows[0].amount,
        "0",
      );
    },
  );
  await check(
    "T05",
    "Agent admin approves manual bank deposit; bank reference cannot be reused",
    async () => {
      manual = await ok(
        "/api/player/deposits",
        "POST",
        {
          amount: "10000",
          method: "manual",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      const r = await ok(
        "/api/agency/deposits/" + manual.id + "/approve",
        "POST",
        {
          bank_reference: "qa-bank-unique-reference",
          evidence_note: "Matched synthetic bank statement",
        },
        "financeA",
      );
      assert.equal(r.state, "credited");
      const next = await ok(
        "/api/player/deposits",
        "POST",
        {
          amount: "10000",
          method: "manual",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      assert.equal(
        (
          await req(
            "/api/agency/deposits/" + next.id + "/approve",
            "POST",
            {
              bank_reference: "qa-bank-unique-reference",
              evidence_note: "Second claim",
            },
            "financeA",
          )
        ).status,
        409,
      );
    },
  );
  await check(
    "T06",
    "Automatic transaction cannot be marked paid merely by supervisor",
    async () => {
      const d = await ok(
        "/api/player/deposits",
        "POST",
        {
          amount: "1000",
          method: "qris",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      const p = await factorToken("superA", "deposit.override", d.id, {});
      assert.equal(
        (
          await req(
            "/api/agency/deposits/" + d.id + "/approve",
            "POST",
            p,
            "superA",
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM agency_transactions WHERE id=$1",
            [d.id],
          )
        ).rows[0].state,
        "pending",
      );
    },
  );
  await check(
    "T07",
    "Late payment without stock remains received/credit pending",
    async () => {
      late = await ok(
        "/api/player/deposits",
        "POST",
        {
          amount: "100000",
          method: "va",
          idempotency_key: crypto.randomUUID(),
        },
        "playerB",
      );
      await ok(masterPath(B.id) + "/simulation/expire/" + late.id, "POST", {});
      const stock = (
        await pool.query(
          "SELECT amount::text FROM agency_balances WHERE tenant_id=$1 AND code='stock:available'",
          [B.id],
        )
      ).rows[0].amount;
      await ok(
        "/api/player/deposits",
        "POST",
        { amount: stock, method: "qris", idempotency_key: crypto.randomUUID() },
        "playerB",
      );
      const r = await ok(
        masterPath(B.id) + "/simulation/payment/" + late.id,
        "POST",
        { amount: late.amount, reference: "late:" + late.id },
      );
      assert.equal(r.state, "payment_received_credit_pending");
      await topup(B.id, 100000);
      const retry = await ok(
        masterPath(B.id) + "/simulation/payment/" + late.id,
        "POST",
        { amount: late.amount, reference: "late:" + late.id },
      );
      assert.equal(retry.state, "credited");
    },
  );
  await check(
    "T08",
    "New beneficiary requires supervisor; bound approval is single use",
    async () => {
      wd = await ok(
        "/api/player/withdrawals",
        "POST",
        {
          amount: "1000000",
          beneficiary: "BANK-QA-001",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      assert.equal(wd.state, "review");
      const payload = {
        decision: "approve",
        beneficiary_verified: true,
        reason: "Verified synthetic beneficiary",
      };
      const grant = await factorToken(
        "superA2",
        "withdraw.review",
        wd.id,
        payload,
      );
      const spoof = await req(
        "/api/agency/withdrawals/" + wd.id + "/review",
        "POST",
        { ...payload, decision: "reject", ...grant },
        "superA2",
      );
      assert.equal(spoof.status, 403);
      const r = await ok(
        "/api/agency/withdrawals/" + wd.id + "/review",
        "POST",
        { ...payload, ...grant },
        "superA2",
      );
      assert.equal(r.state, "queued");
      assert.equal(
        (
          await req(
            "/api/agency/withdrawals/" + wd.id + "/review",
            "POST",
            { ...payload, ...grant },
            "superA2",
          )
        ).status,
        409,
      );
    },
  );
  await check(
    "T09",
    "Payout timeout is held; retry paid is exactly once, reversal once",
    async () => {
      assert.equal(
        (
          await ok(masterPath(A.id) + "/simulation/payout/" + wd.id, "POST", {
            result: "unknown",
          })
        ).state,
        "unknown",
      );
      await ok(masterPath(A.id) + "/simulation/payout/" + wd.id, "POST", {
        result: "paid",
      });
      await ok(masterPath(A.id) + "/simulation/payout/" + wd.id, "POST", {
        result: "paid",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
            [A.id, "payout-paid:" + wd.id],
          )
        ).rows[0].n,
        1,
      );
      await ok(masterPath(A.id) + "/simulation/payout/" + wd.id, "POST", {
        result: "reversed",
      });
      await ok(masterPath(A.id) + "/simulation/payout/" + wd.id, "POST", {
        result: "reversed",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
            [A.id, "payout-reversed:" + wd.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await check(
    "T10",
    "Threshold < 1m auto, =1m manual and split cash cannot fund payout",
    async () => {
      const auto = await ok(
        "/api/player/withdrawals",
        "POST",
        {
          amount: "999999",
          beneficiary: "BANK-QA-001",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      assert.equal(auto.state, "queued");
      const equal = await ok(
        "/api/player/withdrawals",
        "POST",
        {
          amount: "1000000",
          beneficiary: "BANK-QA-001",
          idempotency_key: crypto.randomUUID(),
        },
        "playerA",
      );
      assert.equal(equal.state, "review");
      await ok(
        "/api/player/withdrawals/" + equal.id + "/cancel",
        "POST",
        {},
        "playerA",
      );
      await pool.query(
        "UPDATE agency_players SET limits=$3 WHERE tenant_id=$1 AND id=$2",
        [B.id, PB.id, JSON.stringify({ beneficiaries: ["BANK-B"] })],
      );
      const b = await ok(
        "/api/player/withdrawals",
        "POST",
        {
          amount: "100000",
          beneficiary: "BANK-B",
          idempotency_key: crypto.randomUUID(),
        },
        "playerB",
      );
      assert.equal(b.state, "awaiting_agent_funding");
      await fund(B.id, 100000);
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM agency_transactions WHERE id=$1",
            [b.id],
          )
        ).rows[0].state,
        "queued",
      );
      await ok(masterPath(B.id) + "/simulation/payout/" + b.id, "POST", {
        result: "failed",
      });
      return {
        below: "queued",
        equal: "review",
        split: "awaiting_agent_funding",
      };
    },
  );
  await check(
    "T11",
    "Game signed launch, reserve, settlement and replay are tenant bound",
    async () => {
      const gid = (
        await pool.query("SELECT id FROM gameops_games WHERE slug='uno-luck'")
      ).rows[0].id;
      await pool.query("UPDATE gameops_games SET status='Active' WHERE id=$1", [
        gid,
      ]);
      await pool.query(
        "UPDATE agency_game_releases SET readiness='publishable',environment='sandbox',launch_url='https://example.test/qa',evidence='Synthetic adapter test' WHERE game_id=$1",
        [gid],
      );
      await ok(masterPath(A.id) + "/games/" + gid, "PUT", {
        entitled: true,
        selected: true,
        position: 1,
      });
      const launch = await ok(
        "/api/player/launch",
        "POST",
        { game_id: gid },
        "playerA",
      );
      const session = await game("redeem", { token: launch.token });
      assert.equal(session.status, 200, JSON.stringify(session.data));
      const body = {
        tenant_id: A.id,
        session_id: session.data.session_id,
        round_ref: crypto.randomUUID(),
        stake: "1000",
        max_payout: "2000",
      };
      const round = await game("reserve", body);
      assert.equal(round.status, 200, JSON.stringify(round.data));
      const settled = await game("settle", {
        tenant_id: A.id,
        round_id: round.data.id,
        payout: "1500",
        evidence: "Synthetic authoritative adapter receipt",
      });
      assert.equal(settled.status, 200, JSON.stringify(settled.data));
      const replay = await game("settle", {
        tenant_id: A.id,
        round_id: round.data.id,
        payout: "1500",
        evidence: "Synthetic authoritative adapter receipt",
      });
      assert.equal(replay.status, 200);
      assert.equal(
        (
          await game("settle", {
            tenant_id: B.id,
            round_id: round.data.id,
            payout: "1500",
            evidence: "wrong tenant",
          })
        ).status,
        404,
      );
      const bad = await game("settle", {
        tenant_id: A.id,
        round_id: round.data.id,
        payout: "1600",
        evidence: "conflict",
      });
      assert.equal(bad.status, 409);
    },
  );
  await check(
    "T12",
    "Concurrent wallet spending cannot exceed available balance",
    async () => {
      const wallet = await ok(
        "/api/player/wallet",
        "GET",
        undefined,
        "playerA",
      );
      const available = BigInt(
          wallet.balances.find((x) => x.code.endsWith(":available")).amount,
        ),
        stake = available / 2n + 1n;
      const responses = await Promise.all(
        [1, 2].map(() =>
          req(
            "/api/player/withdrawals",
            "POST",
            {
              amount: String(stake),
              beneficiary: "BANK-QA-001",
              idempotency_key: crypto.randomUUID(),
            },
            "playerA",
          ),
        ),
      );
      assert.deepEqual(responses.map((x) => x.status).sort(), [201, 409]);
      const count = (
        await pool.query(
          "SELECT count(*)::int AS n FROM agency_balances WHERE tenant_id=$1 AND nonnegative AND amount<0",
          [A.id],
        )
      ).rows[0].n;
      assert.equal(count, 0);
    },
  );
  await check(
    "T13",
    "Gross/net examples and cross-month historical-rate credits reconcile",
    async () => {
      const contracts = [
        { id: "c", effective_period: "2026-01", basis: "net", rate_bps: 2000 },
      ];
      assert.equal(
        calculate(
          [{ period: "2026-11", sales: "100000000", withdrawals: "60000000" }],
          contracts,
        ).total,
        "8000000",
      );
      assert.equal(
        calculate(
          [{ period: "2026-11", sales: "100000000", withdrawals: "60000000" }],
          [{ ...contracts[0], basis: "gross" }],
        ).total,
        "20000000",
      );
      const r = calculate(
        [
          { period: "2026-11", sales: "40000000", withdrawals: "0" },
          { period: "2026-12", sales: "0", withdrawals: "40000000" },
        ],
        contracts,
      );
      assert.equal(r.periods[1].fee, "-8000000");
      assert.equal(r.total, "0");
      return { gross: "20000000", net: "8000000", credit: "-8000000" };
    },
  );
  await check(
    "T14",
    "Website content has CAS, escaped rendering, publication and rollback",
    async () => {
      const content = {
        title: "Alpha QA <script>alert(1)</script>",
        description: "Synthetic website",
        body: "Hello <img src=x onerror=alert(1)>",
        accent: "#7759ed",
      };
      const c = await ok(
        "/api/agency/content/home",
        "PUT",
        { content, expected_version: 0 },
        "marketingA",
      );
      assert.equal(
        (
          await req(
            "/api/agency/content/home",
            "PUT",
            { content, expected_version: 0 },
            "marketingA",
          )
        ).status,
        409,
      );
      await ok(
        "/api/agency/content/" + c.id + "/publish",
        "POST",
        { expected_version: 1 },
        "marketingA",
      );
      const page = await req("/site/" + A.slug, "GET", undefined, null);
      assert.equal(page.status, 200);
      assert.ok(!page.text.includes("<script>alert"));
      assert.ok(page.text.includes("&lt;script&gt;"));
      const c2 = await ok(
        "/api/agency/content/home",
        "PUT",
        { content: { ...content, title: "Second title" }, expected_version: 1 },
        "marketingA",
      );
      await ok(
        "/api/agency/content/" + c.id + "/rollback",
        "POST",
        { version: 1, expected_version: 2 },
        "marketingA",
      );
      assert.equal(
        (
          await req(
            "/api/agency/content/" + c.id + "/publish",
            "POST",
            { expected_version: 3 },
            "ownerB",
          )
        ).status,
        404,
      );
    },
  );
  await check(
    "T15",
    "Staff role/session revoke and CIDR restriction enforced",
    async () => {
      const s = await staff(A.id, "support", "tempA");
      await ok(
        "/api/agency/staff/" + s.id,
        "PATCH",
        { role: "support", status: "disabled", ip_allowlist: [] },
        "ownerA",
      );
      assert.equal(
        (await req("/api/agency/me", "GET", undefined, "tempA")).status,
        401,
      );
      const restricted = await staff(A.id, "support", "restrictedA");
      await pool.query("UPDATE agency_staff SET ip_allowlist=$2 WHERE id=$1", [
        restricted.id,
        JSON.stringify(["203.0.113.0/24"]),
      ]);
      assert.equal(
        (await req("/api/agency/me", "GET", undefined, "restrictedA")).status,
        403,
      );
    },
  );
  await check(
    "T16",
    "Immutable balanced journals and independent cash/coin books",
    async () => {
      const mismatches = (
        await pool.query(
          "SELECT journal_id,unit,sum(delta) FROM agency_entries GROUP BY journal_id,unit HAVING sum(delta)<>0",
        )
      ).rows;
      assert.equal(mismatches.length, 0);
      await assert.rejects(
        pool.query(
          "UPDATE agency_journals SET kind='tampered' WHERE tenant_id=$1",
          [A.id],
        ),
        /immutable/,
      );
      const allocations = (
        await pool.query(
          "SELECT COALESCE(sum((data->>'sales')::numeric),0)::text AS sales FROM agency_journals WHERE tenant_id=$1 AND kind='stock.allocated'",
          [A.id],
        )
      ).rows[0];
      assert.equal(allocations.sales, "0");
    },
  );
  await check(
    "T17",
    "Monthly statement locks and invoice cannot be duplicated",
    async () => {
      const current = new Date(Date.now() + 7 * 3600000)
        .toISOString()
        .slice(0, 7);
      const preview = await ok(
        masterPath(A.id) + "/billing/preview?period=" + current,
      );
      const inv = await ok(masterPath(A.id) + "/billing/close", "POST", {
        period: current,
        simulation_close: true,
        exception_note: "Synthetic UAT reviewed",
      });
      assert.equal(String(inv.total), preview.amount_due);
      const same = await ok(masterPath(A.id) + "/billing/close", "POST", {
        period: current,
        simulation_close: true,
      });
      assert.equal(same.id, inv.id);
    },
  );
  await check(
    "T18",
    "Full server health and admin pages remain available",
    async () => {
      assert.equal(
        (await ok("/health", "GET", undefined, null)).version,
        require("../package.json").version,
      );
      assert.equal((await req("/agents")).status, 200);
      assert.equal((await req("/agency", "GET", undefined, null)).status, 200);
      assert.equal((await req("/api/admin/summary")).status, 200);
    },
  );
  await check(
    "T19",
    "Finalized journals reject appended entries and a failed transaction rolls back every book",
    async () => {
      const entry = (
        await pool.query(
          "SELECT * FROM agency_entries WHERE tenant_id=$1 LIMIT 1",
          [A.id],
        )
      ).rows[0];
      await assert.rejects(
        pool.query(
          "INSERT INTO agency_entries(tenant_id,journal_id,code,unit,delta) VALUES($1,$2,$3,$4,$5)",
          [A.id, entry.journal_id, entry.code, entry.unit, "1"],
        ),
        /finalized/,
      );
      const before = (
        await pool.query(
          "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 ORDER BY code,unit",
          [A.id],
        )
      ).rows;
      const ref = "qa-fault:" + crypto.randomUUID();
      await assert.rejects(
        runtime.agency.core.locked(pool, A.id, async (db) => {
          await runtime.agency.core.post(
            db,
            A.id,
            ref,
            "test.fault",
            "qa",
            runtime.agency.core.move("external:qa", "stock:available", 111n),
          );
          throw Error("injected crash before commit");
        }),
        /injected crash/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT id FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
            [A.id, ref],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 ORDER BY code,unit",
            [A.id],
          )
        ).rows,
        before,
      );
    },
  );
  await check(
    "T20",
    "Restricted players retain history and reviewed withdrawal access but cannot deposit or play",
    async () => {
      const p = await player(A, "restrictedPlayer");
      await paid(A.id, "restrictedPlayer", 5000);
      await ok(
        "/api/agency/players/" + p.id,
        "PATCH",
        { status: "excluded", reason: "Synthetic self-exclusion" },
        "ownerA",
      );
      assert.equal(
        (await req("/api/player/me", "GET", undefined, "restrictedPlayer"))
          .status,
        401,
      );
      const login = await req(
        "/api/player/auth/login",
        "POST",
        {
          tenant: A.slug,
          username: "player_restrictedPlayer".toLowerCase(),
          password,
        },
        null,
      );
      assert.equal(login.status, 200, JSON.stringify(login.data));
      creds.set("restrictedPlayer", {
        id: p.id,
        tenant: A.id,
        cookie: login.headers.get("set-cookie").split(";")[0],
        csrf: login.data.csrf,
      });
      await ok("/api/player/wallet", "GET", undefined, "restrictedPlayer");
      assert.equal(
        (
          await req(
            "/api/player/deposits",
            "POST",
            {
              amount: "1",
              method: "qris",
              idempotency_key: crypto.randomUUID(),
            },
            "restrictedPlayer",
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await ok(
            "/api/player/withdrawals",
            "POST",
            {
              amount: "100",
              beneficiary: "RESTRICTED-QA",
              idempotency_key: crypto.randomUUID(),
            },
            "restrictedPlayer",
          )
        ).state,
        "review",
      );
      const g = (
        await pool.query("SELECT id FROM gameops_games WHERE slug='uno-luck'")
      ).rows[0];
      assert.equal(
        (
          await req(
            "/api/player/launch",
            "POST",
            { game_id: g.id },
            "restrictedPlayer",
          )
        ).status,
        403,
      );
    },
  );
  await check(
    "T21",
    "Signed game nonce replay, forged signatures and release slug substitution are rejected",
    async () => {
      const route = "/api/v4/agency-game/redeem",
        body = { token: "invalid" },
        ts = String(Math.floor(Date.now() / 1000)),
        nonce = crypto.randomBytes(16).toString("hex");
      const headers = {
        "X-Agency-Key": "qa-uno",
        "X-Agency-Timestamp": ts,
        "X-Agency-Nonce": nonce,
        "X-Agency-Signature": crypto
          .createHmac("sha256", gameSecret)
          .update(
            [
              "agency.v1",
              "POST",
              route,
              ts,
              nonce,
              C.sha(JSON.stringify(body)),
            ].join("\n"),
          )
          .digest("hex"),
      };
      assert.equal((await req(route, "POST", body, null, headers)).status, 401);
      assert.equal((await req(route, "POST", body, null, headers)).status, 409);
      assert.equal(
        (
          await req(route, "POST", body, null, {
            ...headers,
            "X-Agency-Nonce": crypto.randomBytes(16).toString("hex"),
            "X-Agency-Signature": "forged",
          })
        ).status,
        401,
      );
      const g = (
        await pool.query(
          "SELECT id FROM gameops_games WHERE slug='mahjong-wild'",
        )
      ).rows[0];
      assert.equal(
        (
          await req("/api/admin/agency/releases/" + g.id, "PUT", {
            slug: "uno-luck",
            readiness: "publishable",
            version: "qa",
            evidence: "Cannot borrow another adapter",
            launch_url: "https://example.test/game",
            environment: "sandbox",
          })
        ).status,
        409,
      );
    },
  );
  await check(
    "T22",
    "Canonical and verified domain routing cannot cross tenant boundaries",
    async () => {
      const c = (
        await ok("/api/agency/content", "GET", undefined, "marketingA")
      ).items.find((x) => x.slug === "home");
      assert.equal(
        (
          await req(
            "/api/agency/content/home",
            "PUT",
            {
              expected_version: c.version,
              content: {
                ...c.draft,
                canonical: "https://" + new URL(base).host + "/site/" + B.slug,
              },
            },
            "marketingA",
          )
        ).status,
        400,
      );
      await pool.query(
        "INSERT INTO agency_domains(domain,tenant_id,token,verified_at,is_primary) VALUES('alpha-qa.example.test',$1,'qa',now(),true)",
        [A.id],
      );
      const page = await req("/", "GET", undefined, null, {
        Host: "alpha-qa.example.test",
      });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("https://alpha-qa.example.test"));
      assert.equal(
        (
          await req("/api/admin/summary", "GET", undefined, "master", {
            Host: "alpha-qa.example.test",
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await req("/api/player/wallet", "GET", undefined, "playerB", {
            Host: "alpha-qa.example.test",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await req("/robots.txt", "GET", undefined, null, {
            Host: "alpha-qa.example.test",
          })
        ).text,
        "User-agent: *\nDisallow: /\n",
      );
      await pool.query(
        "DELETE FROM agency_domains WHERE domain='alpha-qa.example.test'",
      );
    },
  );
  await check(
    "T23",
    "Operational guidance, private export and Chatvice merchant scope follow permissions",
    async () => {
      const help = await ok("/api/agency/help", "GET", undefined, "marketingA");
      assert.ok(help.guide.length >= 7);
      assert.equal(help.chatvice, null);
      assert.equal(
        (
          await req(
            "/api/agency/reports/export",
            "GET",
            undefined,
            "marketingA",
          )
        ).status,
        403,
      );
      const csv = await req(
        "/api/agency/reports/export",
        "GET",
        undefined,
        "financeA",
      );
      assert.equal(csv.status, 200);
      assert.ok(csv.text.includes(dep.id));
      assert.ok(!csv.text.includes(PB.id));
      const c = (
        await ok("/api/agency/content", "GET", undefined, "marketingA")
      ).items.find((x) => x.slug === "home");
      assert.equal(
        (
          await req(
            "/api/agency/content/home",
            "PUT",
            {
              expected_version: c.version,
              content: {
                ...c.draft,
                chatvice_enabled: true,
                chatvice_merchant: "foreign-private-merchant",
              },
            },
            "marketingA",
          )
        ).status,
        409,
      );
    },
  );
  await check(
    "T24",
    "Automatic simulator recovers received deposits, settles cash and completes queued payouts without repeat posting",
    async () => {
      const p = await player(A, "workerPlayer");
      const d = await ok(
        "/api/player/deposits",
        "POST",
        { amount: "100", method: "qris", idempotency_key: crypto.randomUUID() },
        "workerPlayer",
      );
      await pool.query(
        "UPDATE agency_transactions SET created_at=now()-interval '10 seconds' WHERE id=$1",
        [d.id],
      );
      await runtime.agency.runSimulationTick();
      const first = (
        await pool.query("SELECT * FROM agency_transactions WHERE id=$1", [
          d.id,
        ])
      ).rows[0];
      assert.equal(first.state, "credited");
      assert.equal(first.data.settled, true);
      const interrupted = await paid(A.id, "workerPlayer", 100);
      assert.equal(interrupted.data.settled, undefined);
      await pool.query("UPDATE agency_players SET limits=$2 WHERE id=$1", [
        p.id,
        JSON.stringify({ beneficiaries: ["WORKER-BANK"] }),
      ]);
      const w = await ok(
        "/api/player/withdrawals",
        "POST",
        {
          amount: "50",
          beneficiary: "WORKER-BANK",
          idempotency_key: crypto.randomUUID(),
        },
        "workerPlayer",
      );
      assert.equal(w.state, "queued");
      await runtime.agency.runSimulationTick();
      await runtime.agency.runSimulationTick();
      assert.equal(
        (
          await pool.query("SELECT data FROM agency_transactions WHERE id=$1", [
            interrupted.id,
          ])
        ).rows[0].data.settled,
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM agency_transactions WHERE id=$1",
            [w.id],
          )
        ).rows[0].state,
        "paid",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM agency_journals WHERE business_id=$1",
            ["payout-paid:" + w.id],
          )
        ).rows[0].n,
        1,
      );
      const mismatch = (
        await pool.query(
          "SELECT journal_id,unit FROM agency_entries GROUP BY journal_id,unit HAVING sum(delta)<>0",
        )
      ).rows;
      assert.equal(mismatch.length, 0);
    },
  );
  if (process.env.AGENCY_BROWSER === "true")
    await check(
      "BROWSER",
      "Desktop/mobile dashboard and player website use the actual backend",
      async () => {
        const { chromium } = require("playwright");
        const browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox"],
        });
        try {
          const ctx = await browser.newContext();
          const a = creds.get("master"),
            [name, value] = a.cookie.split("=");
          await ctx.addCookies([
            { name, value, url: base, httpOnly: true, sameSite: "Strict" },
          ]);
          const page = await ctx.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(base + "/agents");
          await page
            .getByRole("heading", { name: "Ringkasan", exact: true })
            .waitFor();
          await page
            .getByRole("link", { name: "Deposit & Withdraw", exact: true })
            .click();
          await page.waitForFunction(() =>
            document.querySelector("table tbody tr"),
          );
          await page.screenshot({
            path: path.join(__dirname, "../test-results/agency-desktop.png"),
            fullPage: true,
          });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(base + "/agents#coins");
          await page
            .getByRole("heading", { name: "Stok koin", exact: true })
            .waitFor();
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1,
            ),
          );
          await page.screenshot({
            path: path.join(__dirname, "../test-results/agency-mobile.png"),
            fullPage: true,
          });
          await page.goto(base + "/site/" + A.slug);
          await page.getByRole("button", { name: "Akun & Wallet" }).click();
          await page
            .getByRole("heading", { name: "Masuk akun", exact: true })
            .waitFor();
          assert.deepEqual(errors, []);
          return { pageErrors: 0, viewports: [1440, 390] };
        } finally {
          await browser.close();
        }
      },
    );
}
main()
  .catch((e) => {
    report.failures.push({ id: "SETUP", error: e.stack });
    console.error(e.stack);
  })
  .finally(async () => {
    report.completedAt = new Date().toISOString();
    fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "../test-results/agency-system.json"),
      JSON.stringify(report, null, 2),
    );
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
    if (rootPool) {
      await rootPool.query("DROP SCHEMA " + schema + " CASCADE");
      await rootPool.end();
    }
    console.log(
      JSON.stringify({
        passed: report.checks.length,
        failed: report.failures.length,
        mode: report.mode,
      }),
    );
    process.exitCode = report.failures.length ? 1 : 0;
  });
