"use strict";
const {
  C,
  crypto,
  fail,
  text,
  username,
  roles,
  checkCIDRs,
  transaction,
  audit,
  digest,
  asJson,
} = require("./core");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
function createAuth({ pool, master, production = false }) {
  const vault = C.encryption(master),
    cookies = { staff: "agency_staff", player: "agency_player" };
  let dummy;
  const options = {
    httpOnly: true,
    secure: production,
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 3600000,
  };
  const csrf = (raw) =>
    crypto
      .createHmac("sha256", master)
      .update("agency:csrf:" + raw)
      .digest("base64url");
  function origin(req) {
    const o = req.get("Origin");
    if (req.get("Sec-Fetch-Site") === "cross-site")
      fail(403, "Cross-site request rejected");
    if (o) {
      let u;
      try {
        u = new URL(o);
      } catch {
        fail(403, "Invalid origin");
      }
      if (
        u.host !== req.get("Host") ||
        !["http:", "https:"].includes(u.protocol)
      )
        fail(403, "Cross-site request rejected");
    }
  }
  async function throttle(key, db = pool) {
    const q = await db.query(
      `INSERT INTO gameops_auth_buckets(key,hits,expires_at) VALUES($1,1,now()+interval '15 minutes')
 ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN gameops_auth_buckets.expires_at<now() THEN 1 ELSE gameops_auth_buckets.hits+1 END,
 expires_at=CASE WHEN gameops_auth_buckets.expires_at<now() THEN now()+interval '15 minutes' ELSE gameops_auth_buckets.expires_at END RETURNING hits`,
      [C.sha("agency:" + key)],
    );
    if (q.rows[0].hits > 30)
      fail(429, "Terlalu banyak percobaan, coba lagi nanti");
  }
  function token(req, kind) {
    return (
      String(req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(cookies[kind] + "="))
        ?.slice(cookies[kind].length + 1) || ""
    );
  }
  function publicActor(a) {
    return {
      id: a.id,
      tenant_id: a.tenant_id,
      kind: a.kind,
      status: a.status,
      username: a.username,
      display_name: a.display_name,
      role: a.role,
      profile: a.kind === "player" ? a.profile || {} : undefined,
      permissions: a.kind === "staff" ? roles[a.role] : [],
      mfa_enabled: a.mfa_enabled || false,
      setup_required: a.kind === "staff" && !a.mfa_enabled,
      csrf: csrf(a.raw),
      tenant: a.tenant,
    };
  }
  async function session(req, kind) {
    const raw = token(req, kind);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const table = kind === "staff" ? "agency_staff" : "agency_players",
      fk = kind === "staff" ? "staff_id" : "player_id";
    const q = await pool.query(
      `SELECT a.*,s.id AS session_id,s.expires_at,t.slug,t.name AS tenant_name,t.environment,t.status AS tenant_status,t.policy
 FROM agency_sessions s JOIN ${table} a ON a.id=s.${fk} AND a.tenant_id=s.tenant_id JOIN agency_tenants t ON t.id=s.tenant_id
 WHERE s.token_hash=$1 AND s.expires_at>now() AND a.auth_version=s.auth_version AND ${kind === "staff" ? "a.status='active'" : "a.status IN ('active','suspended','excluded')"}`,
      [C.sha(raw)],
    );
    if (!q.rowCount) return null;
    const a = q.rows[0];
    if (req.agencySite && req.agencySite.id !== a.tenant_id)
      fail(403, "Session bukan milik website ini");
    if (
      kind === "staff" &&
      (!checkCIDRs(a.ip_allowlist, req.ip) ||
        !checkCIDRs(a.policy.ip_allowlist || [], req.ip))
    )
      fail(403, "IP staff tidak diizinkan");
    return {
      ...a,
      raw,
      kind,
      tenant: {
        id: a.tenant_id,
        slug: a.slug,
        name: a.tenant_name,
        environment: a.environment,
        status: a.tenant_status,
      },
    };
  }
  const middleware = (kind) =>
    wrap(async (req, res, next) => {
      const a = await session(req, kind);
      if (!a) fail(401, "Login diperlukan", "LOGIN_REQUIRED");
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        origin(req);
        if (!req.is("application/json")) fail(415, "JSON required");
        if (!C.equal(req.get("X-CSRF-Token") || "", csrf(a.raw)))
          fail(403, "CSRF validation failed");
      }
      req.agency = a;
      if (
        kind === "staff" &&
        !a.mfa_enabled &&
        ![
          "/me",
          "/auth/logout",
          "/auth/mfa/start",
          "/auth/mfa/confirm",
        ].includes(req.path)
      )
        fail(
          403,
          "Aktifkan authenticator untuk akses staff",
          "MFA_SETUP_REQUIRED",
        );
      next();
    });
  async function factor(db, a, code) {
    if (!a.mfa_enabled) fail(403, "Authenticator belum aktif");
    const step = C.matchTotp(
      vault.open(a.mfa_secret, a.id),
      code,
      a.mfa_last_step,
    );
    if (step === null)
      fail(401, "Kode authenticator salah atau sudah digunakan");
    const q = await db.query(
      "UPDATE agency_staff SET mfa_last_step=$3 WHERE tenant_id=$1 AND id=$2 AND mfa_last_step<$3 RETURNING id",
      [a.tenant_id, a.id, step],
    );
    if (!q.rowCount) fail(401, "Kode sudah digunakan");
  }
  async function reauth(db, a, p) {
    const q = await db.query(
      "SELECT * FROM agency_staff WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [a.tenant_id, a.id],
    );
    const fresh = q.rows[0];
    if (
      !fresh ||
      fresh.status !== "active" ||
      fresh.auth_version !== a.auth_version ||
      !(await C.passwordVerify(p.password, fresh.password_hash))
    )
      fail(401, "Autentikasi ulang gagal");
    await factor(db, fresh, p.code);
    return fresh;
  }
  async function grant(db, req, res, kind, a, tenant) {
    const raw = crypto.randomBytes(32).toString("base64url");
    const fk = kind === "staff" ? "staff_id" : "player_id";
    await db.query(
      `INSERT INTO agency_sessions(tenant_id,${fk},token_hash,auth_version,ip,user_agent,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '8 hours')`,
      [
        tenant.id,
        a.id,
        C.sha(raw),
        a.auth_version,
        String(req.ip || "").slice(0, 64),
        String(req.get("User-Agent") || "").slice(0, 300),
      ],
    );
    if (kind === "player") {
      const signal =
        String(req.get("X-Device-ID") || "").slice(0, 100) +
        "|" +
        String(req.get("User-Agent") || "").slice(0, 300);
      const fp = crypto
        .createHmac("sha256", master)
        .update(tenant.id + ":" + signal)
        .digest("hex");
      await db.query(
        "INSERT INTO agency_device_events(tenant_id,player_id,ip,user_agent,fingerprint) VALUES($1,$2,$3,$4,$5)",
        [
          tenant.id,
          a.id,
          String(req.ip || "").slice(0, 64),
          String(req.get("User-Agent") || "").slice(0, 300),
          fp,
        ],
      );
    }
    await audit(db, tenant.id, a.id, "auth.login", a.id, { kind });
    return {
      actor: { ...a, kind, raw, tenant },
      cookie: () => res.cookie(cookies[kind], raw, options),
    };
  }
  function mount(app) {
    for (const kind of ["staff", "player"]) {
      const prefix = kind === "staff" ? "/api/agency" : "/api/player",
        table = kind === "staff" ? "agency_staff" : "agency_players";
      app.post(
        prefix + "/auth/login",
        wrap(async (req, res) => {
          origin(req);
          await throttle(
            "login:" + req.ip + ":" + String(req.body?.username || ""),
          );
          if (req.agencySite && req.agencySite.slug !== req.body?.tenant)
            fail(403, "Website agen berbeda");
          const p = req.body || {},
            u = String(p.username || "").trim().toLowerCase();
          const tenant = (
            await pool.query("SELECT * FROM agency_tenants WHERE slug=$1", [
              String(p.tenant || ""),
            ])
          ).rows[0];
          const a = tenant
            ? (
                await pool.query(
                  `SELECT * FROM ${table} WHERE tenant_id=$1 AND username=$2`,
                  [tenant.id, u],
                )
              ).rows[0]
            : null;
          if (
            !(await C.passwordVerify(p.password, a?.password_hash || dummy)) ||
            !a ||
            (kind === "staff" && a.status !== "active") ||
            tenant.status === "closed"
          )
            fail(401, "Username atau password salah");
          if (
            kind === "staff" &&
            (!checkCIDRs(a.ip_allowlist, req.ip) ||
              !checkCIDRs(tenant.policy.ip_allowlist || [], req.ip))
          )
            fail(403, "IP staff tidak diizinkan");
          if (kind === "staff" && a.mfa_enabled && !p.code)
            return res.status(202).json({
              code: "MFA_REQUIRED",
              error: "Masukkan kode authenticator",
            });
          const result = await transaction(pool, async (db) => {
            const fresh = (
              await db.query(
                `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
                [tenant.id, a.id],
              )
            ).rows[0];
            if (
              (kind === "staff" && fresh.status !== "active") ||
              fresh.auth_version !== a.auth_version
            )
              fail(401, "Login berubah, coba lagi");
            if (kind === "staff" && fresh.mfa_enabled)
              await factor(db, fresh, p.code);
            return grant(db, req, res, kind, fresh, tenant);
          });
          result.cookie();
          res.json(publicActor(result.actor));
        }),
      );
      app.use(prefix, middleware(kind));
      app.get(
        prefix + "/me",
        wrap(async (req, res) => res.json(publicActor(req.agency))),
      );
      app.post(
        prefix + "/auth/logout",
        wrap(async (req, res) => {
          await pool.query(
            "DELETE FROM agency_sessions WHERE tenant_id=$1 AND id=$2",
            [req.agency.tenant_id, req.agency.session_id],
          );
          res.clearCookie(cookies[kind], { ...options, maxAge: undefined });
          res.json({ ok: true });
        }),
      );
    }
    app.post(
      "/api/agency/auth/mfa/start",
      wrap(async (req, res) => {
        const a = req.agency;
        await throttle("mfa:" + req.ip + ":" + a.id);
        if (a.mfa_enabled) fail(409, "Authenticator sudah aktif");
        if (!(await C.passwordVerify(req.body?.password, a.password_hash)))
          fail(401, "Password salah");
        const secret = C.base32(crypto.randomBytes(20));
        await pool.query(
          "UPDATE agency_staff SET mfa_secret=$3 WHERE tenant_id=$1 AND id=$2 AND NOT mfa_enabled",
          [a.tenant_id, a.id, vault.seal(secret, a.id)],
        );
        res.json({
          secret,
          uri:
            "otpauth://totp/Playground:" +
            encodeURIComponent(a.username) +
            "?secret=" +
            secret +
            "&issuer=Playground",
        });
      }),
    );
    app.post(
      "/api/agency/auth/mfa/confirm",
      wrap(async (req, res) => {
        const a = req.agency;
        await throttle("mfa:" + req.ip + ":" + a.id);
        await transaction(pool, async (db) => {
          const fresh = (
            await db.query(
              "SELECT * FROM agency_staff WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [a.tenant_id, a.id],
            )
          ).rows[0];
          if (fresh.mfa_enabled || !fresh.mfa_secret)
            fail(409, "Enrollment tidak tersedia");
          const step = C.matchTotp(
            vault.open(fresh.mfa_secret, a.id),
            req.body?.code,
          );
          if (step === null) fail(401, "Kode tidak sesuai");
          await db.query(
            "UPDATE agency_staff SET mfa_enabled=true,mfa_last_step=$3 WHERE tenant_id=$1 AND id=$2",
            [a.tenant_id, a.id, step],
          );
          await audit(db, a.tenant_id, a.id, "staff.mfa.enabled", a.id);
        });
        res.json({ ok: true });
      }),
    );
  }
  async function init() {
    dummy = await C.passwordHash(crypto.randomBytes(32).toString("base64url"));
  }
  return {
    init,
    mount,
    session,
    publicActor,
    origin,
    throttle,
    reauth,
    factor,
    vault,
    grant,
  };
}
module.exports = { createAuth, wrap };
