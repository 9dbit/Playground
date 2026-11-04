"use strict";
const path = require("node:path");
const core = require("./core");
const {
  C,
  crypto,
  fail,
  id,
  slug,
  text,
  username,
  amount,
  key,
  digest,
  asJson,
  permit,
  roles,
  checkCIDRs,
  locked,
  transaction,
  audit,
  post,
  move,
  balance,
  defaults,
  validatePolicy,
  period,
} = core;
const { ddl } = require("./schema");
const { createAuth, wrap } = require("./auth");
const { createCashier, tx } = require("./cashier");
const { createBilling } = require("./billing");
const { createGames } = require("./games");
function createAgency({
  pool,
  security,
  master,
  publicDir,
  production = false,
  gameKeys = [],
  simulationWorker = false,
  chatvice = {},
}) {
  const auth = createAuth({ pool, master, production }),
    billing = createBilling({ pool }),
    games = createGames({ pool, gameKeys });
  function payload(p) {
    const { approval_token, password, code, ...rest } = p || {};
    return rest;
  }
  function proof(action, resource, p) {
    return digest({
      action,
      resource: {
        id: resource.id,
        amount: resource.amount,
        beneficiary: resource.beneficiary,
        state: resource.state,
        policy_version: resource.policy_version,
        config_version: resource.config_version,
      },
      payload: payload(p),
    });
  }
  async function verifyApproval(db, a, action, resource, p) {
    const q = await db.query(
      "SELECT * FROM agency_approvals WHERE tenant_id=$1 AND staff_id=$2 AND token_hash=$3 FOR UPDATE",
      [a.tenant_id, a.id, C.sha(String(p.approval_token || ""))],
    );
    const grant = q.rows[0];
    if (
      !grant ||
      grant.used_at ||
      new Date(grant.expires_at) < new Date() ||
      grant.action !== action ||
      grant.resource !== resource.id ||
      grant.digest !== proof(action, resource, p)
    )
      fail(403, "Approval supervisor kedaluwarsa atau tidak cocok");
    await db.query("UPDATE agency_approvals SET used_at=now() WHERE id=$1", [
      grant.id,
    ]);
    await audit(db, a.tenant_id, a.id, "approval.used", resource.id, {
      action,
    });
  }
  const cashier = createCashier({ pool, verifyApproval });
  const actor = (req) =>
    req.agency || {
      id: req.auth.id,
      kind: "master",
      role: req.auth.role,
      username: req.auth.username,
    };
  const scope = (req) => req.agency?.tenant_id || id(req.params.tenant);
  function allow(req, permission) {
    if (req.agency) permit(req.agency, permission);
    else if (!req.auth || !security.full(req.auth) || req.auth.role !== "owner")
      fail(403, "Platform owner required");
  }
  async function createTenant(p, a) {
    if (
      !Number.isInteger(p.rate_bps ?? 2000) ||
      (p.rate_bps ?? 2000) < 0 ||
      (p.rate_bps ?? 2000) > 10000 ||
      !Number.isInteger(p.coin_scale ?? 0) ||
      (p.coin_scale ?? 0) < 0 ||
      (p.coin_scale ?? 0) > 12 ||
      !["SHARED", "SPLIT"].includes(p.account_mode || "SHARED")
    )
      fail(400, "Konfigurasi agen tidak valid");
    if (!["gross", "net"].includes(p.fee_basis))
      fail(400, "Pilih basis invoice gross atau net");
    const tenantSlug = slug(p.slug),
      name = text(p.name, 100),
      user = username(p.owner_username);
    if (!C.passwordValid(p.owner_password))
      fail(400, "Password owner harus 15–128 karakter");
    const hash = await C.passwordHash(p.owner_password);
    return transaction(pool, async (db) => {
      const t = (
        await db.query(
          "INSERT INTO agency_tenants(slug,name,policy,website,coin_multiplier,coin_scale) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
          [
            tenantSlug,
            name,
            asJson(defaults()),
            asJson({
              title: name,
              description: "Selamat datang di " + name,
              accent: "#7759ed",
              published: false,
            }),
            String(amount(p.coin_multiplier || "1")),
            Number.isInteger(p.coin_scale) ? p.coin_scale : 0,
          ],
        )
      ).rows[0];
      const s = (
        await db.query(
          "INSERT INTO agency_staff(tenant_id,username,display_name,password_hash,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,username,role",
          [t.id, user, text(p.owner_name || user, 100), hash],
        )
      ).rows[0];
      const mode = p.account_mode === "SPLIT" ? "SPLIT" : "SHARED";
      await db.query(
        "INSERT INTO agency_gateway_accounts(tenant_id,mode,deposit_account,withdrawal_account,verified) VALUES($1,$2,$3,$4,true)",
        [
          t.id,
          mode,
          "sim:" + t.id + ":deposit",
          "sim:" + t.id + (mode === "SHARED" ? ":deposit" : ":withdraw"),
        ],
      );
      await db.query(
        "INSERT INTO agency_contracts(tenant_id,effective_period,basis,rate_bps,terms) VALUES($1,$2,$3,$4,$5)",
        [
          t.id,
          period(),
          p.fee_basis,
          p.rate_bps ?? 2000,
          asJson({ credit_policy: "historical-rate-LIFO" }),
        ],
      );
      await db.query(
        "INSERT INTO agency_games(tenant_id,game_id) SELECT $1,id FROM gameops_games",
        [t.id],
      );
      await audit(db, t.id, a.id, "tenant.created", t.id, {
        environment: "sandbox",
      });
      return { tenant: t, owner: s };
    });
  }
  async function overview(tid, privateData = true) {
    const t = (
      await pool.query("SELECT * FROM agency_tenants WHERE id=$1", [tid])
    ).rows[0];
    if (!t) fail(404, "Agen tidak ditemukan");
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*) FROM agency_players WHERE tenant_id=$1)::int AS players,(SELECT count(*) FROM agency_rounds WHERE tenant_id=$1)::int AS rounds,(SELECT count(*) FROM agency_tickets WHERE tenant_id=$1 AND status<>'closed')::int AS tickets`,
        [tid],
      )
    ).rows[0];
    const balances = privateData
      ? (
          await pool.query(
            "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 ORDER BY code,unit",
            [tid],
          )
        ).rows
      : [];
    const exceptions = privateData
      ? (
          await pool.query(
            "SELECT id,kind,state,amount::text,created_at FROM agency_transactions WHERE tenant_id=$1 AND state IN ('review','unknown','awaiting_agent_funding','payment_received_credit_pending') ORDER BY created_at LIMIT 100",
            [tid],
          )
        ).rows
      : [];
    const totals = privateData
      ? (
          await pool.query(
            "SELECT COALESCE(sum((data->>'sales')::numeric),0)::text AS sales,COALESCE(sum((data->>'withdrawals')::numeric),0)::text AS withdrawals FROM agency_journals WHERE tenant_id=$1",
            [tid],
          )
        ).rows[0]
      : null;
    return {
      tenant: {
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        environment: t.environment,
        currency: t.currency,
        coin_scale: t.coin_scale,
        config_version: t.config_version,
      },
      counts,
      balances,
      exceptions,
      totals,
      as_of: new Date().toISOString(),
      capabilities: {
        central_ledger: true,
        agency_cashier: true,
        simulation: true,
        live_gateway: false,
        passkey: false,
        password_totp: true,
        game_adapters: games.configured,
        chatvice_configured: !!chatvice.origin,
        auto_payout_worker: simulationWorker,
      },
    };
  }
  async function init() {
    await pool.query(ddl);
    await pool.query(
      "INSERT INTO agency_game_releases(game_id) SELECT id FROM gameops_games ON CONFLICT DO NOTHING",
    );
    await auth.init();
  }
  function mount(app) {
    // Public registration is deliberately registered before the authenticated player prefix.
    app.post(
      "/api/player/auth/register",
      wrap(async (req, res) => {
        auth.origin(req);
        if (req.agencySite && req.agencySite.slug !== req.body?.tenant)
          fail(403, "Website agen berbeda");
        await auth.throttle("register:" + req.ip);
        const p = req.body || {},
          user = username(String(p.username || "").toLowerCase());
        if (!C.passwordValid(p.password))
          fail(400, "Password harus 15–128 karakter");
        const hash = await C.passwordHash(p.password);
        const found = (
          await pool.query("SELECT id FROM agency_tenants WHERE slug=$1", [
            String(p.tenant || ""),
          ])
        ).rows[0];
        if (!found) fail(404, "Website agen tidak ditemukan");
        const out = await locked(pool, found.id, async (db, t) => {
          if (!["sandbox", "active"].includes(t.status))
            fail(409, "Registrasi ditutup");
          const a = (
            await db.query(
              "INSERT INTO agency_players(tenant_id,username,password_hash,display_name) VALUES($1,$2,$3,$4) RETURNING *",
              [t.id, user, hash, text(p.display_name || user, 100)],
            )
          ).rows[0];
          await audit(db, t.id, a.id, "player.registered", a.id);
          return auth.grant(db, req, res, "player", a, t);
        });
        out.cookie();
        res.status(201).json(auth.publicActor(out.actor));
      }),
    );
    auth.mount(app);
    app.get("/agency", (_req, res) =>
      res.sendFile(path.join(publicDir, "agency.html")),
    );
    app.get("/agents", security.protectedPage("agency.html"));
    for (const f of [
      "agency.js",
      "agency.css",
      "agency-player.js",
      "agency-nav.js",
      "agency-chatvice.js",
    ])
      app.get("/assets/" + f, (_req, res) =>
        res.sendFile(path.join(publicDir, f)),
      );
    app.get(
      "/api/admin/agency/tenants",
      wrap(async (req, res) => {
        allow(req, "overview");
        res.json({
          items: (
            await pool.query(
              "SELECT id,slug,name,status,environment,currency,created_at FROM agency_tenants ORDER BY created_at DESC",
            )
          ).rows,
        });
      }),
    );
    app.post(
      "/api/admin/agency/tenants",
      wrap(async (req, res) => {
        allow(req, "overview");
        res.status(201).json(await createTenant(req.body, actor(req)));
      }),
    );
    app.get(
      "/api/admin/agency/capabilities",
      wrap(async (req, res) => {
        allow(req, "overview");
        res.json({
          version: "agency-1",
          phase: "sandbox",
          livePayments: false,
          centralLedger: true,
          games: games.configured,
          readiness: (
            await pool.query(
              "SELECT g.name,g.slug,r.* FROM agency_game_releases r JOIN gameops_games g ON g.id=r.game_id ORDER BY g.name",
            )
          ).rows,
        });
      }),
    );
    app.put(
      "/api/admin/agency/releases/:game",
      wrap(async (req, res) => {
        allow(req, "overview");
        const p = req.body;
        const registered = (
          await pool.query("SELECT slug FROM gameops_games WHERE id=$1", [
            id(req.params.game),
          ])
        ).rows[0];
        if (!registered) fail(404, "Game tidak ditemukan");
        if (
          ![
            "registered",
            "connectivity",
            "rounds",
            "launch",
            "wallet",
            "publishable",
          ].includes(p.readiness) ||
          !["sandbox", "live"].includes(p.environment)
        )
          fail(400, "Readiness tidak valid");
        let launch = "";
        if (p.launch_url) {
          const u = new URL(p.launch_url);
          if (u.protocol !== "https:") fail(400, "HTTPS launch wajib");
          launch = u.toString();
        }
        if (
          p.readiness === "publishable" &&
          (!launch ||
            !p.evidence ||
            !p.version ||
            !games.configured.some(
              (x) =>
                x.game === registered.slug &&
                x.environment === p.environment &&
                x.enabled,
            ))
        )
          fail(409, "Launch URL dan key adapter terkonfigurasi wajib");
        const q = await pool.query(
          "UPDATE agency_game_releases SET readiness=$2,version=$3,environment=$4,launch_url=$5,evidence=$6,updated_at=now() WHERE game_id=$1 RETURNING *",
          [
            id(req.params.game),
            p.readiness,
            text(p.version || "1", 60),
            p.environment,
            launch,
            text(p.evidence, 1000),
          ],
        );
        if (!q.rowCount) fail(404, "Game tidak ditemukan");
        await audit(
          pool,
          null,
          actor(req).id,
          "game.release.updated",
          req.params.game,
          { readiness: p.readiness },
        );
        res.json(q.rows[0]);
      }),
    );
    for (const prefix of ["/api/agency", "/api/admin/agency/tenants/:tenant"]) {
      app.get(
        prefix + "/overview",
        wrap(async (req, res) => {
          allow(req, "overview");
          const a = actor(req);
          res.json(
            await overview(
              scope(req),
              a.kind === "master" || roles[a.role].includes("finance.read"),
            ),
          );
        }),
      );
      app.get(
        prefix + "/games",
        wrap(async (req, res) => {
          allow(req, "overview");
          res.json({ items: await games.catalog(pool, scope(req)) });
        }),
      );
      app.put(
        prefix + "/games/:game",
        wrap(async (req, res) => {
          allow(req, "games.select");
          const t = scope(req),
            a = actor(req),
            p = req.body;
          res.json(
            await locked(pool, t, async (db) => {
              const old = (
                await db.query(
                  "SELECT * FROM agency_games WHERE tenant_id=$1 AND game_id=$2",
                  [t, id(req.params.game)],
                )
              ).rows[0];
              if (!old) fail(404, "Game tidak ditemukan");
              if (typeof p.selected !== "boolean")
                fail(400, "selected harus boolean");
              if (a.kind !== "master" && Object.hasOwn(p, "entitled"))
                fail(403, "Entitlement diatur Playground");
              const entitlement =
                a.kind === "master" && typeof p.entitled === "boolean"
                  ? p.entitled
                  : old.entitled;
              if (p.selected && !entitlement) fail(403, "Game tidak diizinkan");
              const q = await db.query(
                "UPDATE agency_games SET selected=$3,entitled=$4,position=$5 WHERE tenant_id=$1 AND game_id=$2 RETURNING *",
                [
                  t,
                  old.game_id,
                  p.selected,
                  entitlement,
                  Number.isInteger(p.position) ? p.position : old.position,
                ],
              );
              await audit(db, t, a.id, "games.selection", old.game_id, {
                selected: p.selected,
                entitled: entitlement,
              });
              return q.rows[0];
            }),
          );
        }),
      );
      app.get(
        prefix + "/players",
        wrap(async (req, res) => {
          allow(req, "players.read");
          res.json({
            items: (
              await pool.query(
                "SELECT id,username,display_name,status,created_at FROM agency_players WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.get(
        prefix + "/players/:player",
        wrap(async (req, res) => {
          allow(req, "players.read");
          const t = scope(req),
            p = id(req.params.player),
            a = actor(req);
          const item = (
            await pool.query(
              "SELECT id,username,display_name,status,limits,created_at FROM agency_players WHERE tenant_id=$1 AND id=$2",
              [t, p],
            )
          ).rows[0];
          if (!item) fail(404, "Player tidak ditemukan");
          const balances = (
            await pool.query(
              "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 AND code=ANY($2::text[])",
              [t, ["player:" + p + ":available", "player:" + p + ":reserved"]],
            )
          ).rows;
          const risk =
            a.kind === "master" || roles[a.role].includes("risk.read");
          const devices = risk
            ? (
                await pool.query(
                  "SELECT ip,user_agent,fingerprint,source,created_at FROM agency_device_events WHERE tenant_id=$1 AND player_id=$2 ORDER BY id DESC LIMIT 100",
                  [t, p],
                )
              ).rows
            : [];
          res.json({
            item,
            balances,
            devices,
            device_notice:
              "Sinyal perangkat dapat berubah dan tidak membuktikan identitas atau fraud.",
          });
        }),
      );
      app.patch(
        prefix + "/players/:player",
        wrap(async (req, res) => {
          allow(req, "risk.read");
          const t = scope(req),
            p = id(req.params.player);
          res.json(
            await locked(pool, t, async (db) => {
              if (
                !["active", "suspended", "excluded"].includes(req.body.status)
              )
                fail(400, "Status tidak valid");
              const q = await db.query(
                "UPDATE agency_players SET status=$3,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2 RETURNING id,status",
                [t, p, req.body.status],
              );
              if (!q.rowCount) fail(404, "Player tidak ditemukan");
              await db.query(
                "DELETE FROM agency_sessions WHERE tenant_id=$1 AND player_id=$2",
                [t, p],
              );
              await audit(db, t, actor(req).id, "player.status", p, {
                status: req.body.status,
                reason: text(req.body.reason, 500),
              });
              return q.rows[0];
            }),
          );
        }),
      );
      app.get(
        prefix + "/transactions",
        wrap(async (req, res) => {
          allow(req, "finance.read");
          const q = await pool.query(
            "SELECT * FROM agency_transactions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",
            [scope(req)],
          );
          res.json({ items: q.rows });
        }),
      );
      app.get(
        prefix + "/transactions/:transaction",
        wrap(async (req, res) => {
          allow(req, "finance.read");
          const q = await pool.query(
            "SELECT * FROM agency_transactions WHERE tenant_id=$1 AND id=$2",
            [scope(req), id(req.params.transaction)],
          );
          if (!q.rowCount) fail(404, "Transaksi tidak ditemukan");
          res.json(q.rows[0]);
        }),
      );
      app.get(
        prefix + "/coins",
        wrap(async (req, res) => {
          allow(req, "finance.read");
          res.json({
            items: (
              await pool.query(
                "SELECT * FROM agency_allocations WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200",
                [scope(req)],
              )
            ).rows,
            stock: (
              await pool.query(
                "SELECT code,amount::text FROM agency_balances WHERE tenant_id=$1 AND code LIKE 'stock:%'",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.post(
        prefix + "/coins",
        wrap(async (req, res) => {
          allow(req, "coins.request");
          const t = scope(req),
            a = actor(req);
          res.status(201).json(
            await locked(pool, t, async (db) => {
              const q = await db.query(
                "INSERT INTO agency_allocations(tenant_id,amount,reason,requested_by) VALUES($1,$2,$3,$4) RETURNING *",
                [
                  t,
                  String(amount(req.body.amount)),
                  text(req.body.reason, 500),
                  a.id,
                ],
              );
              await audit(db, t, a.id, "coins.requested", q.rows[0].id);
              return q.rows[0];
            }),
          );
        }),
      );
      app.get(
        prefix + "/policy",
        wrap(async (req, res) => {
          allow(req, "policy");
          const q = await pool.query(
            "SELECT policy,config_version FROM agency_tenants WHERE id=$1",
            [scope(req)],
          );
          if (!q.rowCount) fail(404, "Agen tidak ditemukan");
          res.json(q.rows[0]);
        }),
      );
      app.put(
        prefix + "/policy",
        wrap(async (req, res) => {
          allow(req, "policy");
          const a = actor(req),
            t = scope(req);
          res.json(
            await locked(pool, t, async (db, tenant) => {
              if (req.body.expected_version !== tenant.config_version)
                fail(409, "Policy berubah; muat versi terbaru");
              const p = validatePolicy(req.body.policy);
              if (a.kind !== "master")
                await verifyApproval(db, a, "policy.update", tenant, req.body);
              if (!checkCIDRs(p.ip_allowlist, req.ip))
                fail(409, "Whitelist baru akan mengunci sesi ini");
              const q = await db.query(
                "UPDATE agency_tenants SET policy=$2,config_version=config_version+1 WHERE id=$1 RETURNING policy,config_version",
                [t, asJson(p)],
              );
              await audit(db, t, a.id, "policy.updated", t, {
                version: q.rows[0].config_version,
              });
              return q.rows[0];
            }),
          );
        }),
      );
      app.get(
        prefix + "/staff",
        wrap(async (req, res) => {
          allow(req, "team");
          res.json({
            items: (
              await pool.query(
                "SELECT id,username,display_name,role,status,ip_allowlist,mfa_enabled,created_at FROM agency_staff WHERE tenant_id=$1 ORDER BY created_at",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.post(
        prefix + "/staff",
        wrap(async (req, res) => {
          allow(req, "team");
          const p = req.body,
            t = scope(req);
          if (!roles[p.role] || !C.passwordValid(p.password))
            fail(400, "Role/password tidak valid");
          checkCIDRs(p.ip_allowlist || []);
          const hash = await C.passwordHash(p.password);
          res.status(201).json(
            await locked(pool, t, async (db) => {
              const q = await db.query(
                "INSERT INTO agency_staff(tenant_id,username,display_name,role,password_hash,ip_allowlist) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username,display_name,role,status",
                [
                  t,
                  username(p.username),
                  text(p.display_name || p.username, 100),
                  p.role,
                  hash,
                  asJson(p.ip_allowlist || []),
                ],
              );
              await audit(db, t, actor(req).id, "staff.created", q.rows[0].id, {
                role: p.role,
              });
              return q.rows[0];
            }),
          );
        }),
      );
      app.patch(
        prefix + "/staff/:staff",
        wrap(async (req, res) => {
          allow(req, "team");
          const t = scope(req),
            p = req.body,
            s = id(req.params.staff);
          if (!roles[p.role] || !["active", "disabled"].includes(p.status))
            fail(400, "Staff update tidak valid");
          checkCIDRs(p.ip_allowlist || []);
          res.json(
            await locked(pool, t, async (db) => {
              const old = (
                await db.query(
                  "SELECT id,role FROM agency_staff WHERE tenant_id=$1 AND id=$2",
                  [t, s],
                )
              ).rows[0];
              if (!old) fail(404, "Staff tidak ditemukan");
              if (
                old.role === "owner" &&
                (p.role !== "owner" || p.status !== "active")
              ) {
                const n = (
                  await db.query(
                    "SELECT count(*)::int AS n FROM agency_staff WHERE tenant_id=$1 AND role='owner' AND status='active'",
                    [t],
                  )
                ).rows[0].n;
                if (n <= 1)
                  fail(409, "Owner aktif terakhir harus dipertahankan");
              }
              const q = await db.query(
                "UPDATE agency_staff SET role=$3,status=$4,ip_allowlist=$5,auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2 RETURNING id,role,status",
                [t, s, p.role, p.status, asJson(p.ip_allowlist || [])],
              );
              await db.query(
                "DELETE FROM agency_sessions WHERE tenant_id=$1 AND staff_id=$2",
                [t, s],
              );
              await audit(db, t, actor(req).id, "staff.updated", s, {
                sessions_revoked: true,
                role: p.role,
                status: p.status,
              });
              return q.rows[0];
            }),
          );
        }),
      );
      app.get(
        prefix + "/reports",
        wrap(async (req, res) => {
          allow(req, "reports");
          const t = scope(req);
          const rows = (
            await pool.query(
              `SELECT g.name,g.slug,count(*)::int AS rounds,count(*) FILTER(WHERE r.state='settled')::int AS settled,
 COALESCE(sum(r.stake) FILTER(WHERE r.state='settled'),0)::text AS stake,COALESCE(sum(r.payout) FILTER(WHERE r.state='settled'),0)::text AS payout,
 count(*) FILTER(WHERE r.state='settled' AND r.payout>r.stake)::int AS net_wins FROM agency_rounds r JOIN gameops_games g ON g.id=r.game_id WHERE r.tenant_id=$1 GROUP BY g.name,g.slug`,
              [t],
            )
          ).rows;
          res.json({
            items: rows,
            currency: "COIN minor units",
            notice:
              "Observed RTP dan sample bukan bukti fraud; arus kas berbeda dari hasil permainan.",
          });
        }),
      );
      app.get(
        prefix + "/audit",
        wrap(async (req, res) => {
          allow(req, "audit");
          res.json({
            items: (
              await pool.query(
                "SELECT * FROM agency_audit WHERE tenant_id=$1 ORDER BY id DESC LIMIT 200",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.get(
        prefix + "/billing",
        wrap(async (req, res) => {
          allow(req, "billing");
          res.json({
            contracts: (
              await pool.query(
                "SELECT * FROM agency_contracts WHERE tenant_id=$1 ORDER BY effective_period",
                [scope(req)],
              )
            ).rows,
            invoices: (
              await pool.query(
                "SELECT * FROM agency_invoices WHERE tenant_id=$1 ORDER BY period DESC",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.get(
        prefix + "/billing/preview",
        wrap(async (req, res) => {
          allow(req, "billing");
          res.json(
            await billing.statement(scope(req), req.query.period || period()),
          );
        }),
      );
      app.get(
        prefix + "/tickets",
        wrap(async (req, res) => {
          allow(req, "support");
          res.json({
            items: (
              await pool.query(
                "SELECT * FROM agency_tickets WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 200",
                [scope(req)],
              )
            ).rows,
          });
        }),
      );
      app.post(
        prefix + "/tickets",
        wrap(async (req, res) => {
          allow(req, "support");
          const t = scope(req),
            a = actor(req),
            p = req.body;
          res.status(201).json(
            await locked(pool, t, async (db) => {
              const q = await db.query(
                "INSERT INTO agency_tickets(tenant_id,subject,messages) VALUES($1,$2,$3) RETURNING *",
                [
                  t,
                  text(p.subject, 200),
                  asJson([
                    {
                      actor: a.id,
                      body: text(p.body, 4000),
                      at: new Date().toISOString(),
                    },
                  ]),
                ],
              );
              await audit(db, t, a.id, "ticket.created", q.rows[0].id);
              return q.rows[0];
            }),
          );
        }),
      );
      app.post(
        prefix + "/tickets/:ticket/reply",
        wrap(async (req, res) => {
          allow(req, "support");
          const t = scope(req),
            p = req.body;
          if (!["open", "pending", "answered", "closed"].includes(p.status))
            fail(400, "Status tidak valid");
          res.json(
            await locked(pool, t, async (db) => {
              const q = await db.query(
                "UPDATE agency_tickets SET status=$3,messages=messages||$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
                [
                  t,
                  id(req.params.ticket),
                  p.status,
                  asJson([
                    {
                      actor: actor(req).id,
                      body: text(p.body, 4000),
                      at: new Date().toISOString(),
                    },
                  ]),
                ],
              );
              if (!q.rowCount) fail(404, "Tiket tidak ditemukan");
              await audit(db, t, actor(req).id, "ticket.reply", q.rows[0].id);
              return q.rows[0];
            }),
          );
        }),
      );
    }
    app.post(
      "/api/agency/step-up",
      wrap(async (req, res) => {
        const a = req.agency,
          p = req.body;
        const permissions = {
          "withdraw.review": "withdraw.approve",
          "deposit.override": "override",
          "policy.update": "policy",
        };
        if (!permissions[p.action]) fail(400, "Action tidak didukung");
        permit(a, permissions[p.action]);
        await auth.throttle("reauth:" + a.id);
        res.json(
          await locked(pool, a.tenant_id, async (db, t) => {
            await auth.reauth(db, a, p);
            const resource =
              p.action === "policy.update" ? t : await tx(db, t.id, p.resource);
            const token = crypto.randomBytes(32).toString("base64url");
            await db.query(
              "INSERT INTO agency_approvals(tenant_id,staff_id,action,resource,digest,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')",
              [
                t.id,
                a.id,
                p.action,
                resource.id,
                proof(p.action, resource, p.payload),
                C.sha(token),
              ],
            );
            await audit(db, t.id, a.id, "approval.granted", resource.id, {
              action: p.action,
            });
            return { approval_token: token, expires_in: 300 };
          }),
        );
      }),
    );
    app.post(
      "/api/agency/deposits/:transaction/approve",
      wrap(async (req, res) => {
        permit(req.agency, "deposit.approve");
        const o = (
          await pool.query(
            "SELECT method FROM agency_transactions WHERE tenant_id=$1 AND id=$2",
            [req.agency.tenant_id, id(req.params.transaction)],
          )
        ).rows[0];
        if (!o) fail(404, "Transaksi tidak ditemukan");
        if (o.method !== "manual") permit(req.agency, "override");
        res.json(
          await cashier.approveDeposit(
            req.agency,
            req.params.transaction,
            req.body,
          ),
        );
      }),
    );
    app.post(
      "/api/agency/withdrawals/:transaction/review",
      wrap(async (req, res) => {
        permit(req.agency, "withdraw.approve");
        res.json(
          await cashier.approveWithdraw(
            req.agency,
            req.params.transaction,
            req.body,
          ),
        );
      }),
    );
    // Platform operations: allocation, commercial contracts, account mapping, and explicit simulated provider events.
    app.post(
      "/api/admin/agency/tenants/:tenant/coins/:allocation/review",
      wrap(async (req, res) => {
        allow(req, "coins.request");
        const t = scope(req),
          p = req.body,
          a = actor(req);
        res.json(
          await locked(pool, t, async (db, tenant) => {
            const r = (
              await db.query(
                "SELECT * FROM agency_allocations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
                [t, id(req.params.allocation)],
              )
            ).rows[0];
            if (!r || r.status !== "requested")
              fail(409, "Request sudah diproses atau tidak ditemukan");
            if (!["approve", "reject"].includes(p.decision))
              fail(400, "Keputusan tidak valid");
            if (p.decision === "approve") {
              const stock =
                (await balance(db, t, "stock:available")) +
                (await balance(db, t, "stock:reserved"));
              if (stock + BigInt(r.amount) > BigInt(tenant.policy.coin_limit))
                fail(409, "Alokasi melebihi limit stok agen");
              await post(
                db,
                t,
                "allocation:" + r.id,
                "stock.allocated",
                a.id,
                move("external:coin_allocation", "stock:available", r.amount),
                { allocation_id: r.id },
              );
            }
            await db.query(
              "UPDATE agency_allocations SET status=$3,reviewed_by=$4 WHERE tenant_id=$1 AND id=$2",
              [
                t,
                r.id,
                p.decision === "approve" ? "approved" : "rejected",
                a.id,
              ],
            );
            await audit(db, t, a.id, "allocation.reviewed", r.id, {
              decision: p.decision,
            });
            return { ok: true };
          }),
        );
      }),
    );
    app.put(
      "/api/admin/agency/tenants/:tenant/contract",
      wrap(async (req, res) => {
        allow(req, "billing");
        res.json(await billing.contract(scope(req), req.body, actor(req).id));
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/billing/close",
      wrap(async (req, res) => {
        allow(req, "billing");
        res.json(await billing.close(scope(req), req.body, actor(req).id));
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/billing/:invoice/payment",
      wrap(async (req, res) => {
        allow(req, "billing");
        res.json(
          await billing.payment(
            scope(req),
            id(req.params.invoice),
            req.body,
            actor(req).id,
          ),
        );
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/fund",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(await cashier.fund(scope(req), req.body, actor(req).id));
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/payment/:transaction",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(
          await cashier.payment(
            scope(req),
            req.params.transaction,
            {
              reference: text(req.body.reference, 120),
              amount: req.body.amount,
            },
            actor(req).id,
          ),
        );
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/settlement/:transaction",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(
          await cashier.settle(
            scope(req),
            req.params.transaction,
            actor(req).id,
          ),
        );
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/payout/:transaction",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(
          await cashier.payout(
            scope(req),
            req.params.transaction,
            req.body.result,
            actor(req).id,
          ),
        );
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/refund/:transaction",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(
          await cashier.refund(
            scope(req),
            req.params.transaction,
            req.body,
            actor(req).id,
          ),
        );
      }),
    );
    app.post(
      "/api/admin/agency/tenants/:tenant/simulation/expire/:transaction",
      wrap(async (req, res) => {
        allow(req, "finance.read");
        res.json(
          await cashier.expire(
            scope(req),
            req.params.transaction,
            actor(req).id,
          ),
        );
      }),
    );
    app.get(
      "/api/player/wallet",
      wrap(async (req, res) => {
        const a = req.agency;
        res.json({
          balances: (
            await pool.query(
              "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 AND code=ANY($2::text[])",
              [
                a.tenant_id,
                [
                  "player:" + a.id + ":available",
                  "player:" + a.id + ":reserved",
                ],
              ],
            )
          ).rows,
          transactions: (
            await pool.query(
              "SELECT * FROM agency_transactions WHERE tenant_id=$1 AND player_id=$2 ORDER BY created_at DESC LIMIT 100",
              [a.tenant_id, a.id],
            )
          ).rows,
          tenant: a.tenant,
        });
      }),
    );
    app.post(
      "/api/player/deposits",
      wrap(async (req, res) =>
        res.status(201).json(await cashier.deposit(req.agency, req.body)),
      ),
    );
    app.post(
      "/api/player/withdrawals",
      wrap(async (req, res) =>
        res.status(201).json(await cashier.withdraw(req.agency, req.body)),
      ),
    );
    app.post(
      "/api/player/withdrawals/:transaction/cancel",
      wrap(async (req, res) =>
        res.json(await cashier.cancel(req.agency, req.params.transaction)),
      ),
    );
    app.get(
      "/api/player/tickets",
      wrap(async (req, res) =>
        res.json({
          items: (
            await pool.query(
              "SELECT * FROM agency_tickets WHERE tenant_id=$1 AND player_id=$2 ORDER BY updated_at DESC LIMIT 100",
              [req.agency.tenant_id, req.agency.id],
            )
          ).rows,
        }),
      ),
    );
    app.post(
      "/api/player/tickets",
      wrap(async (req, res) => {
        const a = req.agency;
        res.status(201).json(
          await locked(pool, a.tenant_id, async (db) => {
            const q = await db.query(
              "INSERT INTO agency_tickets(tenant_id,player_id,subject,messages) VALUES($1,$2,$3,$4) RETURNING *",
              [
                a.tenant_id,
                a.id,
                text(req.body.subject, 200),
                asJson([
                  {
                    actor: a.id,
                    body: text(req.body.body, 4000),
                    at: new Date().toISOString(),
                  },
                ]),
              ],
            );
            await audit(
              db,
              a.tenant_id,
              a.id,
              "ticket.player_created",
              q.rows[0].id,
            );
            return q.rows[0];
          }),
        );
      }),
    );
    app.get(
      "/api/player/rounds",
      wrap(async (req, res) =>
        res.json({
          items: (
            await pool.query(
              "SELECT r.id,r.round_ref,r.stake::text,r.payout::text,r.state,r.created_at,g.name AS game FROM agency_rounds r JOIN gameops_games g ON g.id=r.game_id WHERE r.tenant_id=$1 AND r.player_id=$2 ORDER BY r.created_at DESC LIMIT 100",
              [req.agency.tenant_id, req.agency.id],
            )
          ).rows,
        }),
      ),
    );
    app.get(
      "/api/player/games",
      wrap(async (req, res) =>
        res.json({
          items: await games.catalog(pool, req.agency.tenant_id, true),
        }),
      ),
    );
    app.post(
      "/api/player/launch",
      wrap(async (req, res) =>
        res.json(await games.launch(req.agency, req.body.game_id)),
      ),
    );
    for (const [action, fn] of [
      ["redeem", games.redeem],
      ["reserve", games.reserve],
      ["settle", games.settle],
      ["void", (p, s) => games.settle(p, s, true)],
    ])
      app.post(
        "/api/v4/agency-game/" + action,
        wrap(async (req, res) =>
          res.json(await fn(req.body, await games.verify(req))),
        ),
      );
  }
  async function runSimulationTick() {
    const expired = (
      await pool.query(
        "SELECT x.tenant_id,x.id FROM agency_transactions x JOIN agency_tenants t ON t.id=x.tenant_id WHERE t.environment='sandbox' AND x.kind='deposit' AND x.state='pending' AND (x.data->>'expires_at')::timestamptz<=now() ORDER BY x.created_at LIMIT 20",
      )
    ).rows;
    for (const d of expired)
      await cashier.expire(d.tenant_id, d.id, "simulation-worker");
    const deposits = (
      await pool.query(
        "SELECT x.tenant_id,x.id,x.amount::text FROM agency_transactions x JOIN agency_tenants t ON t.id=x.tenant_id WHERE t.environment='sandbox' AND x.kind='deposit' AND x.method IN ('qris','va') AND x.state='pending' AND x.created_at<now()-interval '3 seconds' AND (x.data->>'expires_at')::timestamptz>now() ORDER BY x.created_at LIMIT 20",
      )
    ).rows;
    for (const d of deposits)
      await cashier.payment(
        d.tenant_id,
        d.id,
        { amount: d.amount, reference: "simulation-auto:" + d.id },
        "simulation-worker",
      );
    // Settlement has its own durable selector: a restart between received and settled does not strand cash.
    const settlements = (
      await pool.query(
        "SELECT x.tenant_id,x.id FROM agency_transactions x JOIN agency_tenants t ON t.id=x.tenant_id WHERE t.environment='sandbox' AND x.kind='deposit' AND x.method IN ('qris','va') AND x.state<>'refunded' AND x.data->>'received'='true' AND COALESCE(x.data->>'settled','false')<>'true' ORDER BY x.created_at LIMIT 20",
      )
    ).rows;
    for (const d of settlements)
      await cashier.settle(d.tenant_id, d.id, "simulation-worker");
    const jobs = (
      await pool.query(
        "SELECT j.tenant_id,j.transaction_id FROM agency_payout_jobs j JOIN agency_tenants t ON t.id=j.tenant_id WHERE j.state='queued' AND t.environment='sandbox' LIMIT 20",
      )
    ).rows;
    for (const j of jobs)
      await cashier.payout(
        j.tenant_id,
        j.transaction_id,
        "paid",
        "simulation-worker",
      );
    return {
      expired: expired.length,
      deposits: deposits.length,
      settlements: settlements.length,
      payouts: jobs.length,
    };
  }
  function startWorker() {
    if (!simulationWorker) return () => {};
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await runSimulationTick();
      } catch (e) {
        console.error("[agency-worker]", e.code || e.message);
      } finally {
        running = false;
      }
    }, 2000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return {
    init,
    mount,
    startWorker,
    runSimulationTick,
    auth,
    cashier,
    billing,
    games,
    createTenant,
    overview,
    verifyApproval,
    proof,
    allow,
    scope,
    actor,
    core,
  };
}
module.exports = { createAgency };
