"use strict";
const {
  fail,
  id,
  amount,
  key,
  digest,
  asJson,
  locked,
  balance,
  post,
  move,
  audit,
  text,
} = require("./core");
const playerCode = (p, b = "available") => "player:" + p + ":" + b;
async function accounts(db, t) {
  const a = (
    await db.query("SELECT * FROM agency_gateway_accounts WHERE tenant_id=$1", [
      t,
    ])
  ).rows[0];
  if (!a) fail(409, "Account pembayaran belum dipetakan");
  return a;
}
const payoutCode = (a) =>
  a.mode === "SHARED" ? "cash:deposit_available" : "cash:withdraw_available";
function openTenant(t) {
  if (!["sandbox", "active"].includes(t.status))
    fail(409, "Agen tidak menerima transaksi baru");
  if (t.environment !== "sandbox")
    fail(
      503,
      "Gateway live belum diaktifkan; gunakan onboarding provider terverifikasi",
      "LIVE_GATEWAY_UNAVAILABLE",
    );
}
async function tx(db, t, tid, player) {
  const q = await db.query(
    "SELECT * FROM agency_transactions WHERE tenant_id=$1 AND id=$2" +
      (player ? " AND player_id=$3" : "") +
      " FOR UPDATE",
    player ? [t, id(tid), player] : [t, id(tid)],
  );
  if (!q.rowCount) fail(404, "Transaksi tidak ditemukan");
  return q.rows[0];
}
async function update(db, t, o, state, data = {}, actor) {
  return (
    await db.query(
      "UPDATE agency_transactions SET state=$3,data=data||$4::jsonb,approved_by=COALESCE($5,approved_by),updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [t, o.id, state, asJson(data), actor || null],
    )
  ).rows[0];
}
async function duplicate(db, t, kind, k, hash) {
  const q = await db.query(
    "SELECT * FROM agency_transactions WHERE tenant_id=$1 AND kind=$2 AND request_key=$3",
    [t, kind, k],
  );
  if (!q.rowCount) return null;
  if (q.rows[0].request_digest !== hash)
    fail(409, "Idempotency payload changed");
  return q.rows[0];
}
async function fulfill(db, t, o, actor) {
  if (o.data.fulfilled) return o;
  if (!o.data.received) fail(409, "Dana belum terverifikasi");
  const n = BigInt(o.coins);
  if (!o.data.stock_reserved) {
    if ((await balance(db, t.id, "stock:available")) < n)
      return update(db, t.id, o, "payment_received_credit_pending");
    await post(
      db,
      t.id,
      "late-reserve:" + o.id,
      "stock.reserve",
      actor,
      move("stock:available", "stock:reserved", n),
    );
    o.data.stock_reserved = true;
  }
  await post(
    db,
    t.id,
    "sale:" + o.id,
    "coin.sale",
    actor,
    move("stock:reserved", playerCode(o.player_id), n),
    { sales: String(o.amount), transaction_id: o.id, player_id: o.player_id },
  );
  return update(db, t.id, o, "credited", {
    fulfilled: true,
    stock_reserved: false,
    fulfilled_at: new Date().toISOString(),
  });
}
async function receive(db, t, o, event, actor) {
  if (o.kind !== "deposit") fail(409, "Bukan deposit");
  if (o.state === "refunded") fail(409, "Deposit sudah direfund");
  const hash = digest({
    transaction: o.id,
    amount: String(event.amount),
    reference: event.reference,
    account: o.account_ref,
  });
  const provider = event.manual ? "manual-bank" : "simulation";
  const old = await db.query(
    "SELECT digest FROM agency_payment_events WHERE provider=$1 AND account_ref=$2 AND event_ref=$3",
    [provider, o.account_ref, text(event.reference, 120)],
  );
  if (old.rowCount) {
    if (old.rows[0].digest !== hash)
      fail(409, "Referensi pembayaran sudah dipakai");
    return fulfill(db, t, o, actor);
  }
  if (BigInt(o.amount) !== amount(event.amount))
    fail(400, "Nominal pembayaran tidak cocok");
  if (o.data.received) fail(409, "Transaksi telah menerima pembayaran");
  await db.query(
    "INSERT INTO agency_payment_events(tenant_id,provider,account_ref,event_ref,digest,transaction_id,data) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [t.id, provider, o.account_ref, event.reference, hash, o.id, asJson(event)],
  );
  const cash = event.manual ? "cash:manual_available" : "cash:deposit_pending";
  await post(
    db,
    t.id,
    "payment:" + o.id,
    "deposit.received",
    actor,
    move("external:player_cash", cash, o.amount, t.currency),
    { transaction_id: o.id, reference: event.reference },
  );
  o = await update(db, t.id, o, "payment_received_credit_pending", {
    received: true,
    received_at: new Date().toISOString(),
    received_ref: event.reference,
    manual_bank: !!event.manual,
  });
  return fulfill(db, t, o, actor);
}
async function queue(db, t, o, actor) {
  const a = await accounts(db, t.id);
  if (o.account_ref !== a.withdrawal_account || o.account_version !== a.version)
    fail(
      409,
      "Mapping account berubah; rekonsiliasi transaksi lama sebelum melanjutkan",
    );
  if ((await balance(db, t.id, payoutCode(a), t.currency)) < BigInt(o.amount))
    return update(
      db,
      t.id,
      o,
      "awaiting_agent_funding",
      { approved: true },
      actor,
    );
  await post(
    db,
    t.id,
    "payout-reserve:" + o.id,
    "withdraw.cash_reserved",
    actor,
    move(payoutCode(a), "cash:payout_reserved", o.amount, t.currency),
    { transaction_id: o.id },
  );
  await db.query(
    "INSERT INTO agency_payout_jobs(tenant_id,transaction_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [t.id, o.id],
  );
  return update(
    db,
    t.id,
    o,
    "queued",
    { approved: true, cash_reserved: true },
    actor,
  );
}
function createCashier({
  pool,
  verifyApproval = async () => fail(403, "Approval required"),
}) {
  async function deposit(a, p) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const n = amount(p.amount),
        method = p.method;
      if (!["qris", "va", "manual"].includes(method))
        fail(400, "Metode deposit tidak tersedia");
      const k = key(p.idempotency_key),
        hash = digest({ player: a.id, amount: String(n), method });
      const old = await duplicate(db, t.id, "deposit", k, hash);
      if (old) return old;
      openTenant(t);
      const player = (
        await db.query(
          "SELECT status FROM agency_players WHERE tenant_id=$1 AND id=$2",
          [t.id, a.id],
        )
      ).rows[0];
      if (!player || player.status !== "active")
        fail(403, "Player dibatasi; deposit dan permainan baru ditutup");
      const g = await accounts(db, t.id),
        coins = n * BigInt(t.coin_multiplier);
      if (coins.toString().length > 37) fail(400, "Nominal terlalu besar");
      const o = (
        await db.query(
          `INSERT INTO agency_transactions(tenant_id,player_id,kind,method,amount,coins,state,request_key,request_digest,account_ref,account_version,policy_version,created_by,data)
 VALUES($1,$2::uuid,'deposit',$3,$4,$5,'pending',$6,$7,$8,$9,$10,$2::text,$11) RETURNING *`,
          [
            t.id,
            a.id,
            method,
            String(n),
            String(coins),
            k,
            hash,
            g.deposit_account,
            g.version,
            t.config_version,
            asJson({
              stock_reserved: true,
              expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
              simulation: true,
            }),
          ],
        )
      ).rows[0];
      await post(
        db,
        t.id,
        "checkout:" + o.id,
        "stock.reserve",
        a.id,
        move("stock:available", "stock:reserved", coins),
        { transaction_id: o.id },
      );
      return o;
    });
  }
  async function payment(tid, oid, event, actor) {
    return locked(pool, tid, async (db, t) => {
      if (t.environment !== "sandbox")
        fail(503, "Adapter provider live belum aktif");
      const o = await tx(db, t.id, oid);
      if (o.method === "manual" && !event.manual)
        fail(409, "Transfer manual memerlukan pemeriksaan admin");
      return receive(db, t, o, event, actor);
    });
  }
  async function approveDeposit(a, oid, p) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const o = await tx(db, t.id, oid);
      if (o.kind !== "deposit") fail(409, "Bukan deposit");
      if (o.method === "manual") {
        if (!p.bank_reference || !p.evidence_note)
          fail(400, "Referensi mutasi dan catatan verifikasi wajib");
        await audit(db, t.id, a.id, "deposit.manual_verified", o.id, {
          reference: p.bank_reference,
          note: text(p.evidence_note, 500),
        });
        return receive(
          db,
          t,
          o,
          {
            reference: text(p.bank_reference, 120),
            amount: o.amount,
            manual: true,
          },
          a.id,
        );
      }
      await verifyApproval(db, a, "deposit.override", o, p);
      if (!o.data.received)
        fail(
          409,
          "Bukti provider belum diterima; approval tidak dapat menciptakan deposit",
        );
      return fulfill(db, t, o, a.id);
    });
  }
  async function settle(tid, oid, actor) {
    return locked(pool, tid, async (db, t) => {
      const o = await tx(db, t.id, oid);
      if (t.environment !== "sandbox")
        fail(503, "Settlement live harus berasal dari provider");
      if (!o.data.received || o.data.manual_bank)
        fail(409, "Tidak ada settlement gateway pending");
      if (o.data.settled) return o;
      await post(
        db,
        t.id,
        "deposit-settled:" + o.id,
        "deposit.settled",
        actor,
        move(
          "cash:deposit_pending",
          "cash:deposit_available",
          o.amount,
          t.currency,
        ),
      );
      return update(db, t.id, o, o.state, { settled: true });
    });
  }
  async function expire(tid, oid, actor) {
    return locked(pool, tid, async (db, t) => {
      const o = await tx(db, t.id, oid);
      if (o.kind !== "deposit" || o.data.received)
        fail(409, "Deposit tidak dapat dikedaluwarsakan");
      if (!o.data.stock_reserved) return o;
      await post(
        db,
        t.id,
        "expire:" + o.id,
        "stock.release",
        actor,
        move("stock:reserved", "stock:available", o.coins),
      );
      return update(db, t.id, o, "expired", { stock_reserved: false });
    });
  }
  async function withdraw(a, p) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const n = amount(p.amount),
        beneficiary = text(p.beneficiary, 160),
        k = key(p.idempotency_key),
        hash = digest({ player: a.id, amount: String(n), beneficiary });
      const old = await duplicate(db, t.id, "withdraw", k, hash);
      if (old) return old;
      openTenant(t);
      const g = await accounts(db, t.id),
        coins = n * BigInt(t.coin_multiplier);
      const player = (
        await db.query(
          "SELECT * FROM agency_players WHERE tenant_id=$1 AND id=$2",
          [t.id, a.id],
        )
      ).rows[0];
      if (!player) fail(404, "Player tidak ditemukan");
      const day = (
        await db.query(
          `SELECT COALESCE(sum(amount),0)::text AS total,count(*)::int AS count FROM agency_transactions WHERE tenant_id=$1 AND player_id=$2 AND kind='withdraw' AND state NOT IN ('cancelled','rejected','failed') AND created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'`,
          [t.id, a.id],
        )
      ).rows[0];
      const known = (player.limits.beneficiaries || []).includes(beneficiary);
      const risk =
        n + BigInt(day.total) > BigInt(t.policy.daily_withdraw_limit) ||
        day.count >= t.policy.daily_withdraw_count ||
        !known;
      const auto =
        player.status === "active" &&
        t.policy.auto_withdraw &&
        n < BigInt(t.policy.withdraw_threshold) &&
        !risk;
      let o = (
        await db.query(
          `INSERT INTO agency_transactions(tenant_id,player_id,kind,method,amount,coins,state,request_key,request_digest,account_ref,account_version,policy_version,beneficiary,created_by,data)
 VALUES($1,$2::uuid,'withdraw','disbursement',$3,$4,'review',$5,$6,$7,$8,$9,$10,$2::text,$11) RETURNING *`,
          [
            t.id,
            a.id,
            String(n),
            String(coins),
            k,
            hash,
            g.withdrawal_account,
            g.version,
            t.config_version,
            beneficiary,
            asJson({
              automatic: auto,
              review_reason: !known
                ? "beneficiary_review"
                : risk
                  ? "daily_limit"
                  : auto
                    ? null
                    : "threshold",
              simulation: true,
            }),
          ],
        )
      ).rows[0];
      await post(
        db,
        t.id,
        "withdraw:" + o.id,
        "withdraw.wallet_reserved",
        a.id,
        move(playerCode(a.id), playerCode(a.id, "reserved"), coins),
        { transaction_id: o.id },
      );
      if (auto) o = await queue(db, t, o, "policy:" + t.config_version);
      return o;
    });
  }
  async function approveWithdraw(a, oid, p) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const o = await tx(db, t.id, oid);
      if (o.kind !== "withdraw" || o.state !== "review")
        fail(409, "Withdraw tidak menunggu approval");
      if (o.created_by === a.id)
        fail(403, "Pengaju tidak boleh menyetujui sendiri");
      await verifyApproval(db, a, "withdraw.review", o, p);
      if (p.decision === "reject") {
        await post(
          db,
          t.id,
          "withdraw-reject:" + o.id,
          "withdraw.rejected",
          a.id,
          move(
            playerCode(o.player_id, "reserved"),
            playerCode(o.player_id),
            o.coins,
          ),
          { reason: text(p.reason, 500) },
        );
        return update(db, t.id, o, "rejected", {}, a.id);
      }
      if (p.decision !== "approve" || !p.beneficiary_verified)
        fail(400, "Verifikasi beneficiary wajib");
      await db.query(
        `UPDATE agency_players SET limits=jsonb_set(limits,'{beneficiaries}',COALESCE(limits->'beneficiaries','[]')||$3::jsonb) WHERE tenant_id=$1 AND id=$2`,
        [t.id, o.player_id, asJson([o.beneficiary])],
      );
      await audit(db, t.id, a.id, "withdraw.approved", o.id, {
        beneficiary_verified: true,
        policy_version: o.policy_version,
      });
      return queue(db, t, o, a.id);
    });
  }
  async function fund(tid, p, actor) {
    return locked(pool, tid, async (db, t) => {
      openTenant(t);
      if (!["risk", "deposit", "withdraw"].includes(p.target))
        fail(400, "Target funding tidak valid");
      const g = await accounts(db, t.id),
        n = amount(p.amount),
        k = key(p.idempotency_key),
        destination =
          p.target === "risk"
            ? "game:pool"
            : p.target === "deposit"
              ? "cash:deposit_available"
              : payoutCode(g),
        unit = p.target === "risk" ? "COIN" : t.currency;
      await post(
        db,
        t.id,
        "fund:" + k,
        "simulation.funding",
        actor,
        move("external:agent_funding", destination, n, unit),
        { target: destination, simulation: true },
      );
      const pending = (
        await db.query(
          "SELECT * FROM agency_transactions WHERE tenant_id=$1 AND state='awaiting_agent_funding' ORDER BY created_at,id",
          [t.id],
        )
      ).rows;
      for (const o of pending) await queue(db, t, o, o.approved_by || "policy");
      return { ok: true, target: destination, simulation: true };
    });
  }
  async function payout(tid, oid, result, actor) {
    return locked(pool, tid, async (db, t) => {
      if (t.environment !== "sandbox")
        fail(503, "Payout live belum diaktifkan");
      const o = await tx(db, t.id, oid),
        g = await accounts(db, t.id);
      if (o.kind !== "withdraw") fail(409, "Bukan withdraw");
      if (!["paid", "failed", "unknown", "reversed"].includes(result))
        fail(400, "Status payout tidak valid");
      if (o.state === result) return o;
      if (result === "reversed") {
        if (o.state !== "paid") fail(409, "Hanya payout paid dapat direversal");
        await post(
          db,
          t.id,
          "payout-reversed:" + o.id,
          "withdraw.reversed",
          actor,
          [
            ...move(
              "external:player_cash",
              payoutCode(g),
              o.amount,
              t.currency,
            ),
            ...move("external:redeemed", playerCode(o.player_id), o.coins),
          ],
          { withdrawals: String(-BigInt(o.amount)), transaction_id: o.id },
        );
      } else {
        if (!["queued", "unknown", "submitted"].includes(o.state))
          fail(409, "Payout belum disetujui atau tidak dapat dikirim");
        if (result === "paid")
          await post(
            db,
            t.id,
            "payout-paid:" + o.id,
            "withdraw.paid",
            actor,
            [
              ...move(
                "cash:payout_reserved",
                "external:player_cash",
                o.amount,
                t.currency,
              ),
              ...move(
                playerCode(o.player_id, "reserved"),
                "external:redeemed",
                o.coins,
              ),
            ],
            {
              withdrawals: String(o.amount),
              transaction_id: o.id,
              player_id: o.player_id,
            },
          );
        if (result === "failed")
          await post(
            db,
            t.id,
            "payout-failed:" + o.id,
            "withdraw.failed",
            actor,
            [
              ...move(
                "cash:payout_reserved",
                payoutCode(g),
                o.amount,
                t.currency,
              ),
              ...move(
                playerCode(o.player_id, "reserved"),
                playerCode(o.player_id),
                o.coins,
              ),
            ],
          );
      }
      await db.query(
        "UPDATE agency_payout_jobs SET state=$3,attempts=attempts+1,provider_ref=COALESCE(provider_ref,$4),updated_at=now() WHERE tenant_id=$1 AND transaction_id=$2",
        [t.id, o.id, result, "sim:" + o.id],
      );
      return update(db, t.id, o, result, {
        provider_ref: "sim:" + o.id,
        result_at: new Date().toISOString(),
        cash_reserved: result === "unknown",
      });
    });
  }
  async function refund(tid, oid, p, actor) {
    return locked(pool, tid, async (db, t) => {
      openTenant(t);
      const o = await tx(db, t.id, oid);
      if (o.kind !== "deposit" || !o.data.received)
        fail(409, "Tidak ada deposit diterima");
      if (o.state === "refunded") return o;
      const cash = o.data.manual_bank
        ? "cash:manual_available"
        : o.data.settled
          ? "cash:deposit_available"
          : "cash:deposit_pending";
      const lines = move(cash, "external:player_cash", o.amount, t.currency);
      if (o.data.fulfilled)
        lines.push(
          ...move(playerCode(o.player_id), "stock:available", o.coins),
        );
      else if (o.data.stock_reserved)
        lines.push(...move("stock:reserved", "stock:available", o.coins));
      await post(db, t.id, "refund:" + o.id, "deposit.refund", actor, lines, {
        sales: o.data.fulfilled ? String(-BigInt(o.amount)) : "0",
        transaction_id: o.id,
        reason: text(p.reason, 500),
      });
      return update(db, t.id, o, "refunded", {
        stock_reserved: false,
        refund_at: new Date().toISOString(),
      });
    });
  }
  async function cancel(a, oid) {
    return locked(pool, a.tenant_id, async (db, t) => {
      const o = await tx(db, t.id, oid, a.id);
      if (
        o.kind !== "withdraw" ||
        !["review", "awaiting_agent_funding"].includes(o.state)
      )
        fail(409, "Transaksi tidak dapat dibatalkan pada status ini");
      await post(
        db,
        t.id,
        "withdraw-cancel:" + o.id,
        "withdraw.cancelled",
        a.id,
        move(playerCode(a.id, "reserved"), playerCode(a.id), o.coins),
      );
      return update(db, t.id, o, "cancelled");
    });
  }
  return {
    deposit,
    payment,
    approveDeposit,
    settle,
    expire,
    withdraw,
    approveWithdraw,
    fund,
    payout,
    refund,
    cancel,
  };
}
module.exports = {
  createCashier,
  playerCode,
  accounts,
  payoutCode,
  tx,
  fulfill,
};
