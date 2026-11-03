"use strict";
const crypto = require("node:crypto"),
  net = require("node:net");
const { RequestError, transaction } = require("../transaction");
const C = require("../security-crypto");
const roles = {
  owner: [
    "overview",
    "finance.read",
    "deposit.approve",
    "withdraw.approve",
    "coins.request",
    "players.read",
    "risk.read",
    "reports",
    "games.select",
    "website",
    "team",
    "policy",
    "billing",
    "support",
    "audit",
  ],
  finance: [
    "overview",
    "finance.read",
    "deposit.approve",
    "coins.request",
    "players.read",
    "reports",
    "billing",
    "support",
  ],
  supervisor: [
    "overview",
    "finance.read",
    "deposit.approve",
    "withdraw.approve",
    "override",
    "coins.request",
    "players.read",
    "risk.read",
    "reports",
    "policy",
    "billing",
    "support",
    "audit",
  ],
  support: ["overview", "players.read", "support"],
  marketing: ["overview", "games.select", "website", "support"],
  analyst: ["overview", "reports", "billing"],
};
const fail = (status, message, code) => {
  throw new RequestError(status, message, code);
};
function text(x, max = 200) {
  if (typeof x !== "string" || !x.trim() || x.length > max)
    fail(400, "Invalid text");
  return x.trim();
}
function id(x) {
  if (
    typeof x !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      x,
    )
  )
    fail(400, "Invalid identifier");
  return x;
}
function slug(x) {
  if (typeof x !== "string" || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(x))
    fail(400, "Invalid slug");
  return x;
}
function username(x) {
  if (typeof x !== "string" || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(x))
    fail(400, "Invalid username");
  return x;
}
function amount(x, zero = false) {
  if (typeof x === "number" && !Number.isSafeInteger(x))
    fail(400, "Use an integer string");
  const s = String(x);
  if (!/^(0|[1-9][0-9]{0,29})$/.test(s) || (!zero && s === "0"))
    fail(400, "Invalid amount");
  return BigInt(s);
}
function key(x) {
  if (typeof x !== "string" || !/^[A-Za-z0-9_.:-]{8,180}$/.test(x))
    fail(400, "An idempotency key is required");
  return x;
}
function stable(x) {
  if (Array.isArray(x)) return x.map(stable);
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, stable(x[k])]),
    );
  return typeof x === "bigint" ? String(x) : x;
}
const digest = (x) => C.sha(JSON.stringify(stable(x)));
const escape = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const asJson = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? String(v) : v));
function permit(actor, permission) {
  if (
    !actor ||
    actor.kind !== "staff" ||
    !(roles[actor.role] || []).includes(permission)
  )
    fail(403, "Akses tidak diizinkan", "AGENCY_FORBIDDEN");
}
function checkCIDRs(list, ip) {
  if (!Array.isArray(list) || list.length > 30)
    fail(400, "Invalid IP allowlist");
  if (!list.length) return true;
  const b = new net.BlockList();
  for (const item of list) {
    if (typeof item !== "string") fail(400, "Invalid CIDR");
    const [address, prefix, ...extra] = item.split("/"),
      v = net.isIP(address);
    if (
      !v ||
      extra.length ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix))
    )
      fail(400, "Invalid CIDR");
    try {
      if (prefix !== undefined)
        b.addSubnet(address, Number(prefix), v === 6 ? "ipv6" : "ipv4");
      else b.addAddress(address, v === 6 ? "ipv6" : "ipv4");
    } catch {
      fail(400, "Invalid CIDR");
    }
  }
  if (ip === undefined) return true;
  const normalized = String(ip).replace(/^::ffff:/, "");
  return (
    !!net.isIP(normalized) &&
    b.check(normalized, net.isIP(normalized) === 6 ? "ipv6" : "ipv4")
  );
}
async function audit(db, tenant, actor, action, resource, details = {}) {
  await db.query(
    "INSERT INTO agency_audit(tenant_id,actor,action,resource,details) VALUES($1,$2,$3,$4,$5)",
    [tenant, actor, action, String(resource), asJson(details)],
  );
}
async function locked(pool, tenant, fn) {
  return transaction(pool, async (db) => {
    const q = await db.query(
      "SELECT * FROM agency_tenants WHERE id=$1 FOR UPDATE",
      [id(tenant)],
    );
    if (!q.rowCount) fail(404, "Agen tidak ditemukan");
    return fn(db, q.rows[0]);
  });
}
async function balance(db, t, code, unit = "COIN") {
  const q = await db.query(
    "SELECT amount::text FROM agency_balances WHERE tenant_id=$1 AND code=$2 AND unit=$3",
    [t, code, unit],
  );
  return BigInt(q.rows[0]?.amount || 0);
}
// Must be called while holding the tenant row lock. This establishes a single lock order.
async function post(db, t, business, kind, actor, lines, data = {}) {
  const nonzero = lines
    .filter((x) => BigInt(x.delta) !== 0n)
    .map((x) => ({ ...x, delta: String(x.delta), unit: x.unit || "COIN" }));
  const sums = new Map();
  for (const l of nonzero)
    sums.set(l.unit, (sums.get(l.unit) || 0n) + BigInt(l.delta));
  if (!nonzero.length || [...sums.values()].some((x) => x !== 0n))
    fail(500, "Unbalanced posting");
  const hash = digest({ kind, lines: nonzero, data });
  const old = await db.query(
    "SELECT id,digest FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
    [t, business],
  );
  if (old.rowCount) {
    if (old.rows[0].digest !== hash) fail(409, "Idempotency payload changed");
    return { id: old.rows[0].id, duplicate: true };
  }
  const j = (
    await db.query(
      "INSERT INTO agency_journals(tenant_id,business_id,kind,digest,actor,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [t, business, kind, hash, actor, asJson(data)],
    )
  ).rows[0];
  for (const l of nonzero) {
    const constrained =
      !l.code.startsWith("external:") && !l.code.startsWith("clearing:");
    await db.query(
      "INSERT INTO agency_balances(tenant_id,code,unit,nonnegative) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [t, l.code, l.unit, constrained],
    );
    const q = await db.query(
      "UPDATE agency_balances SET amount=amount+$4 WHERE tenant_id=$1 AND code=$2 AND unit=$3 AND (NOT nonnegative OR amount+$4>=0) RETURNING amount",
      [t, l.code, l.unit, l.delta],
    );
    if (!q.rowCount)
      fail(409, "Saldo atau stok tidak mencukupi", "INSUFFICIENT_BALANCE");
    await db.query(
      "INSERT INTO agency_entries(tenant_id,journal_id,code,unit,delta) VALUES($1,$2,$3,$4,$5)",
      [t, j.id, l.code, l.unit, l.delta],
    );
  }
  await audit(db, t, actor, "ledger." + kind, j.id, { business_id: business });
  return j;
}
const move = (from, to, n, unit = "COIN") => [
  { code: from, unit, delta: -BigInt(n) },
  { code: to, unit, delta: BigInt(n) },
];
function defaults() {
  return {
    auto_withdraw: true,
    withdraw_threshold: "1000000",
    daily_withdraw_limit: "5000000",
    daily_withdraw_count: 10,
    coin_limit: "100000000",
    pending_hours: 24,
    ip_allowlist: [],
    risk_reserve: "0",
  };
}
function validatePolicy(p) {
  if (!p || Array.isArray(p) || typeof p !== "object")
    fail(400, "Invalid policy");
  const d = defaults();
  if (Object.keys(p).some((k) => !Object.hasOwn(d, k)))
    fail(400, "Unknown policy field");
  const n = { ...d, ...p };
  for (const k of [
    "withdraw_threshold",
    "daily_withdraw_limit",
    "coin_limit",
    "risk_reserve",
  ])
    n[k] = String(amount(n[k], k === "risk_reserve"));
  if (
    typeof n.auto_withdraw !== "boolean" ||
    !Number.isInteger(n.daily_withdraw_count) ||
    n.daily_withdraw_count < 1 ||
    n.daily_withdraw_count > 1000 ||
    !Number.isInteger(n.pending_hours) ||
    n.pending_hours < 1 ||
    n.pending_hours > 168
  )
    fail(400, "Invalid policy limits");
  checkCIDRs(n.ip_allowlist);
  return n;
}
const period = (date = new Date()) =>
  new Date(new Date(date).getTime() + 7 * 3600000).toISOString().slice(0, 7);
function periodBounds(p) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(p)) fail(400, "Invalid billing period");
  const start = new Date(p + "-01T00:00:00+07:00");
  const end = new Date(
    Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 1) - 7 * 3600000,
  );
  return { start, end };
}
module.exports = {
  C,
  crypto,
  RequestError,
  transaction,
  roles,
  fail,
  text,
  id,
  slug,
  username,
  amount,
  key,
  digest,
  escape,
  asJson,
  permit,
  checkCIDRs,
  audit,
  locked,
  balance,
  post,
  move,
  defaults,
  validatePolicy,
  period,
  periodBounds,
};
