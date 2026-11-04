"use strict";
const {
  fail,
  amount,
  key,
  digest,
  asJson,
  locked,
  audit,
  post,
  move,
  period,
  periodBounds,
} = require("./core");
const rounded = (basis, bps) => (basis * BigInt(bps) + 5000n) / 10000n;
// Historical-rate credit lots: negative basis cancels the most recent billed basis first.
// Recompute remaining fee after each cancellation so partial credits cannot accumulate rounding errors.
function calculate(rows, contracts) {
  let carry = 0n;
  const lots = [],
    periods = [];
  let lastBasis;
  for (const row of rows) {
    const c = contracts.filter((x) => x.effective_period <= row.period).at(-1);
    if (!c)
      fail(409, "Kontrak billing belum tersedia untuk periode " + row.period);
    if (lastBasis && lastBasis !== c.basis)
      fail(409, "Perubahan basis membutuhkan settlement kontrak sebelumnya");
    lastBasis = c.basis;
    const sales = BigInt(row.sales),
      withdrawals = BigInt(row.withdrawals),
      base = c.basis === "gross" ? sales : sales - withdrawals;
    let fee = 0n,
      remaining = base;
    const corrections = [];
    if (remaining >= 0n) {
      const offset = remaining < carry ? remaining : carry;
      remaining -= offset;
      carry -= offset;
      if (remaining > 0n) {
        fee = rounded(remaining, c.rate_bps);
        lots.push({ period: row.period, remaining, fee, rate: c.rate_bps });
      }
    } else {
      let need = -remaining;
      while (need > 0n && lots.length) {
        const lot = lots.at(-1),
          used = need < lot.remaining ? need : lot.remaining;
        const newFee = rounded(lot.remaining - used, lot.rate),
          credit = lot.fee - newFee;
        fee -= credit;
        lot.remaining -= used;
        lot.fee = newFee;
        need -= used;
        corrections.push({
          period: lot.period,
          basis: String(used),
          credit: String(credit),
          rate_bps: lot.rate,
        });
        if (lot.remaining === 0n) lots.pop();
      }
      carry += need;
    }
    periods.push({
      period: row.period,
      sales: String(sales),
      withdrawals: String(withdrawals),
      basis: c.basis,
      rate_bps: c.rate_bps,
      basis_amount: String(base),
      fee: String(fee),
      negative_carry: String(carry),
      corrections,
      contract_id: c.id,
      rounding: "nearest-minor-unit",
      credit_policy: "historical-rate-LIFO",
    });
  }
  return {
    periods,
    total: String(periods.reduce((n, x) => n + BigInt(x.fee), 0n)),
    negative_carry: String(carry),
  };
}
function createBilling({ pool }) {
  async function preview(db, t, p) {
    const { end } = periodBounds(p);
    const rows = (
      await db.query(
        `SELECT to_char(created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM') AS period,
 COALESCE(sum((data->>'sales')::numeric),0)::text AS sales,COALESCE(sum((data->>'withdrawals')::numeric),0)::text AS withdrawals
 FROM agency_journals WHERE tenant_id=$1 AND created_at<$2 AND (data ? 'sales' OR data ? 'withdrawals') GROUP BY 1 ORDER BY 1`,
        [t.id, end.toISOString()],
      )
    ).rows;
    if (!rows.some((x) => x.period === p))
      rows.push({ period: p, sales: "0", withdrawals: "0" });
    rows.sort((a, b) => a.period.localeCompare(b.period));
    const contracts = (
      await db.query(
        "SELECT * FROM agency_contracts WHERE tenant_id=$1 ORDER BY effective_period",
        [t.id],
      )
    ).rows;
    const computed = calculate(rows, contracts);
    const existing = (
      await db.query(
        "SELECT total::text,period FROM agency_invoices WHERE tenant_id=$1 AND period<=$2 ORDER BY period",
        [t.id, p],
      )
    ).rows;
    const billed = existing.reduce((n, x) => n + BigInt(x.total), 0n),
      current = computed.periods.find((x) => x.period === p);
    const balances = (
      await db.query(
        "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 ORDER BY code,unit",
        [t.id],
      )
    ).rows;
    return {
      ...current,
      calculated_cumulative_fee: computed.total,
      previously_invoiced: String(billed),
      amount_due: String(BigInt(computed.total) - billed),
      balances,
      computed_periods: computed.periods,
      environment: t.environment,
      currency: t.currency,
      as_of: new Date().toISOString(),
      timezone: "Asia/Jakarta",
    };
  }
  async function contract(tid, p, actor) {
    return locked(pool, tid, async (db, t) => {
      periodBounds(p.effective_period);
      if (
        !["gross", "net"].includes(p.basis) ||
        !Number.isInteger(p.rate_bps ?? 2000) ||
        (p.rate_bps ?? 2000) < 0 ||
        (p.rate_bps ?? 2000) > 10000
      )
        fail(400, "Kontrak tidak valid");
      if (
        (
          await db.query(
            "SELECT 1 FROM agency_invoices WHERE tenant_id=$1 AND period>=$2 LIMIT 1",
            [t.id, p.effective_period],
          )
        ).rowCount
      )
        fail(409, "Periode kontrak sudah ditutup");
      const old = (
        await db.query(
          "SELECT * FROM agency_contracts WHERE tenant_id=$1 ORDER BY effective_period",
          [t.id],
        )
      ).rows;
      const used = (
        await db.query(
          "SELECT 1 FROM agency_journals WHERE tenant_id=$1 AND data ? 'sales' LIMIT 1",
          [t.id],
        )
      ).rowCount;
      if (used && old.some((x) => x.basis !== p.basis))
        fail(
          409,
          "Basis kontrak yang sudah dipakai tidak dapat diganti tanpa settlement/migrasi",
        );
      if (used && p.effective_period <= period())
        fail(409, "Rate baru berlaku paling cepat bulan berikutnya");
      const c = (
        await db.query(
          "INSERT INTO agency_contracts(tenant_id,effective_period,basis,rate_bps,terms) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,effective_period) DO UPDATE SET basis=EXCLUDED.basis,rate_bps=EXCLUDED.rate_bps,terms=EXCLUDED.terms RETURNING *",
          [
            t.id,
            p.effective_period,
            p.basis,
            p.rate_bps ?? 2000,
            asJson({ ...p.terms, credit_policy: "historical-rate-LIFO" }),
          ],
        )
      ).rows[0];
      await audit(db, t.id, actor, "contract.updated", c.id, {
        effective_period: p.effective_period,
        rate_bps: c.rate_bps,
        basis: c.basis,
      });
      return c;
    });
  }
  async function statement(tid, p) {
    return locked(pool, tid, (db, t) => preview(db, t, p));
  }
  async function close(tid, p, actor) {
    return locked(pool, tid, async (db, t) => {
      periodBounds(p.period);
      const old = (
        await db.query(
          "SELECT * FROM agency_invoices WHERE tenant_id=$1 AND period=$2",
          [t.id, p.period],
        )
      ).rows[0];
      if (old) return old;
      if (
        p.period >= period() &&
        !(t.environment === "sandbox" && p.simulation_close === true)
      )
        fail(409, "Periode belum berakhir");
      const later = await db.query(
        "SELECT 1 FROM agency_invoices WHERE tenant_id=$1 AND period>$2",
        [t.id, p.period],
      );
      if (later.rowCount) fail(409, "Periode harus ditutup berurutan");
      const pending = (
        await db.query(
          "SELECT count(*)::int AS n FROM agency_transactions WHERE tenant_id=$1 AND state IN ('unknown','payment_received_credit_pending')",
          [t.id],
        )
      ).rows[0];
      if (pending.n && !p.exception_note)
        fail(
          409,
          "Selesaikan exception atau catat hasil review sebelum closing",
        );
      const s = await preview(db, t, p.period);
      s.exception_note = p.exception_note || null;
      const invoice = (
        await db.query(
          "INSERT INTO agency_invoices(tenant_id,period,total,statement) VALUES($1,$2,$3,$4) RETURNING *",
          [t.id, p.period, s.amount_due, asJson(s)],
        )
      ).rows[0];
      const n = BigInt(s.amount_due);
      if (n !== 0n)
        await post(
          db,
          t.id,
          "invoice:" + invoice.id,
          "billing.invoice",
          actor,
          move(
            "clearing:agent_fees",
            "clearing:platform_receivable",
            n,
            t.currency,
          ),
          { invoice_id: invoice.id, period: p.period },
        );
      await audit(db, t.id, actor, "billing.closed", invoice.id, {
        period: p.period,
        total: s.amount_due,
      });
      return invoice;
    });
  }
  async function payment(tid, i, p, actor) {
    return locked(pool, tid, async (db, t) => {
      const n = amount(p.amount),
        k = key(p.idempotency_key);
      const invoice = (
        await db.query(
          "SELECT * FROM agency_invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [t.id, i],
        )
      ).rows[0];
      if (!invoice) fail(404, "Invoice tidak ditemukan");
      const prior = await db.query(
        "SELECT data FROM agency_journals WHERE tenant_id=$1 AND business_id=$2",
        [t.id, "invoice-payment:" + k],
      );
      if (prior.rowCount) {
        if (
          prior.rows[0].data.invoice_id !== i ||
          prior.rows[0].data.amount !== String(n)
        )
          fail(409, "Idempotency payload changed");
        return invoice;
      }
      if (BigInt(invoice.total) - BigInt(invoice.paid) < n)
        fail(409, "Pembayaran melebihi invoice");
      await post(
        db,
        t.id,
        "invoice-payment:" + k,
        "billing.payment",
        actor,
        move(
          "clearing:platform_receivable",
          "external:platform_paid",
          n,
          t.currency,
        ),
        {
          invoice_id: i,
          amount: String(n),
          reference: String(p.reference || ""),
        },
      );
      const out = (
        await db.query(
          "UPDATE agency_invoices SET paid=paid+$3 WHERE tenant_id=$1 AND id=$2 RETURNING *",
          [t.id, i, String(n)],
        )
      ).rows[0];
      return out;
    });
  }
  return { contract, statement, close, payment };
}
module.exports = { createBilling, calculate, rounded };
