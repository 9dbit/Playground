"use strict";
const { wrap } = require("./auth");
const { fail, periodBounds, period, audit, roles } = require("./core");
const guide = [
  {title:"Request & auto refill coin",body:"Buka Request & riwayat coin. Request manual memiliki ID yang tetap saat dicoba ulang. Agen dapat menjadwalkan request 100 juta coin; refill langsung memerlukan otorisasi master. Batas harian, bulanan, stok, dan status agen tetap diperiksa. Riwayat dan ekspor mencatat waktu pengajuan, pemeriksa, kredit, serta saldo sebelum–sesudah."},
  {title:"Laporan berdasarkan periode",body:"Filter tanggal menggunakan WIB, termasuk seluruh tanggal akhir. Ringkasan coin dikelompokkan menurut waktu pengajuan; arus kas berdasarkan journal termasuk koreksi; ronde berdasarkan waktu selesai. Penjualan dan penarikan tetap terpisah dari stok coin dan laba."},
  {title:"Brand dan kesiapan",body:"Atur logo, favicon, warna, referral, leaderboard dan maintenance pada Brand & kesiapan. Pemeliharaan menahan registrasi, deposit, bonus dan ronde baru; withdraw dan bantuan tetap tersedia."},
  {title:"Bonus dan inbox",body:"Kampanye bonus memakai anggaran yang dicadangkan dari stok agen, satu klaim per pemain, tanpa wagering. Bonus bukan penjualan koin. Tutup kampanye untuk mengembalikan sisa anggaran. Pengumuman inbox hanya untuk pemain aktif agen sendiri."},
  {title:"Pemulihan akun",body:"Pemilik akun mengajukan pemulihan dari login. Admin memverifikasi identitas di luar sistem, lalu memakai password dan authenticator untuk menerbitkan tautan 15 menit, sekali pakai. Semua sesi dicabut setelah reset; MFA tetap aktif. Email otomatis hanya untuk email pemain yang sudah diverifikasi dan provider yang dikonfigurasi."},
  {
    title: "Stok koin",
    body: "Ajukan alokasi ke Playground. Stok yang disetujui belum menjadi penjualan. Checkout mereservasi stok; pembayaran sah memindahkan koin ke wallet pemain.",
  },
  {
    title: "Deposit otomatis dan manual",
    body: "QRIS/VA menunggu konfirmasi provider. Cocokkan mutasi bank untuk transfer manual. Approval supervisor tidak dapat menggantikan bukti dana masuk.",
  },
  {
    title: "Saldo tersedia dan reserve",
    body: "Saldo reserved sedang dipakai transaksi atau ronde. Saldo gateway pending belum menjadi kas tersedia. Stok koin bukan saldo rekening bank.",
  },
  {
    title: "Withdraw",
    body: "Rekening baru dan transaksi yang melampaui policy harus ditinjau. Supervisor memakai password dan authenticator. Approved belum berarti paid. Status unknown harus direkonsiliasi sebelum tindakan berikutnya.",
  },
  {
    title: "Pendanaan disbursement",
    body: "Mode SPLIT memerlukan saldo withdraw tersendiri. Penjualan koin maupun saldo deposit tidak otomatis mendanai account withdraw.",
  },
  {
    title: "Invoice",
    body: "Fee default 20% mengikuti basis gross atau net pada kontrak. Net memakai penjualan koin dikurangi withdraw paid. Pembalikan dan refund dicatat sebagai koreksi, bukan edit journal.",
  },
  {
    title: "Website dan game",
    body: "Pilih game yang diizinkan Playground. Publikasikan konten dengan versi yang benar. Canonical hanya ke domain atau path agen sendiri. Verifikasi TXT dan HTTPS untuk domain khusus.",
  },
  {
    title: "Staff dan dukungan",
    body: "Gunakan akun staff terpisah, authenticator, dan whitelist IP. Perubahan role mencabut sesi lama. Kirim ID transaksi lewat tiket; jangan kirim password, kode authenticator, atau secret.",
  },
];
const cell = (x) =>
  '"' +
  String(x ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replace(/"/g, '""') +
  '"';
function mountOperations(app, { pool, agency, chatvice = {} }) {
  const prefixes = ["/api/agency", "/api/admin/agency/tenants/:tenant"];
  for (const prefix of prefixes) {
    app.get(prefix + '/worklist',wrap(async(req,res)=>{
      agency.allow(req,'overview'); const tid=agency.scope(req),a=agency.actor(req);
      const can=p=>a.kind==='master'||(roles[a.role]||[]).includes(p),items=[];
      const add=async(permission,title,view,sql)=>{if(can(permission)){const r=(await pool.query(sql,[tid])).rows[0];items.push({title,view,count:r.n});}};
      await add('finance.read','Request coin menunggu','coins',"SELECT count(*)::int AS n FROM agency_allocations WHERE tenant_id=$1 AND status='requested'");
      await add('finance.read','Pembayaran perlu ditinjau','transactions',"SELECT count(*)::int AS n FROM agency_transactions WHERE tenant_id=$1 AND (state IN ('review','unknown','awaiting_agent_funding','payment_received_credit_pending') OR (method='manual' AND state='pending'))");
      await add('support','Tiket belum ditutup','support',"SELECT count(*)::int AS n FROM agency_tickets WHERE tenant_id=$1 AND status<>'closed'");
      await add('website','Konten belum dipublikasikan','website',"SELECT count(*)::int AS n FROM agency_content WHERE tenant_id=$1 AND (published IS NULL OR draft IS DISTINCT FROM published)");
      await add('recovery','Permintaan pemulihan','recovery',"SELECT count(*)::int AS n FROM agency_recovery_requests WHERE tenant_id=$1 AND resolved_at IS NULL");
      await add('rewards','Kampanye berakhir perlu ditutup','campaigns',"SELECT count(*)::int AS n FROM agency_campaigns WHERE tenant_id=$1 AND state='active' AND ends_at<=now()");
      res.json({items,as_of:new Date().toISOString()});
    }));
    app.get(
      prefix + "/help",
      wrap(async (req, res) => {
        agency.allow(req, "overview");
        const t = (
          await pool.query("SELECT slug FROM agency_tenants WHERE id=$1", [
            agency.scope(req),
          ])
        ).rows[0];
        if (!t) fail(404, "Agen tidak ditemukan");
        const home = req.agency ? (await pool.query("SELECT published FROM agency_content WHERE tenant_id=$1 AND slug='home'", [agency.scope(req)])).rows[0]?.published : null;
        const merchant = req.agency
          ? (home?.chatvice_configured ? (home.chatvice_enabled ? home.chatvice_merchant : null) : chatvice.tenants?.[t.slug]?.staff)
          : chatvice.masterMerchant;
        res.json({
          version: "2026-11-08.oxplay-1",
          guide,
          chatvice:
            merchant
              ? {
                  origin: "https://chatvice.app",
                  merchant,
                  audience: req.agency ? "agent-sop" : "master-sop",
                  privateLookup: false,
                }
              : null,
          fallback: "tickets",
        });
      }),
    );
    app.get(
      prefix + "/notifications",
      wrap(async (req, res) => {
        agency.allow(req, "finance.read");
        const t = agency.scope(req);
        const items = (
          await pool.query(
            "SELECT id,kind,state,created_at FROM agency_transactions WHERE tenant_id=$1 AND state IN ('review','unknown','awaiting_agent_funding','payment_received_credit_pending') ORDER BY created_at LIMIT 100",
            [t],
          )
        ).rows;
        const balance = (
          await pool.query(
            "SELECT code,unit,amount::text FROM agency_balances WHERE tenant_id=$1 AND code IN ('stock:available','cash:deposit_available','cash:withdraw_available')",
            [t],
          )
        ).rows;
        res.json({ items, balances: balance, as_of: new Date().toISOString() });
      }),
    );
    app.get(
      prefix + "/reports/export",
      wrap(async (req, res) => {
        agency.allow(req, "finance.read");
        const t = agency.scope(req),
          p = req.query.period || period(),
          { start, end } = periodBounds(p);
        const rows = (
          await pool.query(
            "SELECT id,player_id,kind,method,amount::text,coins::text,state,created_at,updated_at FROM agency_transactions WHERE tenant_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at,id LIMIT 10001",
            [t, start.toISOString(), end.toISOString()],
          )
        ).rows;
        if (rows.length > 10000)
          fail(
            409,
            "Export melebihi batas 10.000 baris; gunakan laporan terjadwal",
          );
        const columns = [
          "id",
          "player_id",
          "kind",
          "method",
          "amount",
          "coins",
          "state",
          "created_at",
          "updated_at",
        ];
        await audit(pool, t, agency.actor(req).id, "report.export", p, {
          rows: rows.length,
          type: "transactions",
        });
        res
          .type("text/csv")
          .attachment("transactions-" + p + ".csv")
          .send(
            "\uFEFF" +
              [
                columns.map(cell).join(","),
                ...rows.map((r) =>
                  columns
                    .map((k) =>
                      cell(r[k] instanceof Date ? r[k].toISOString() : r[k]),
                    )
                    .join(","),
                ),
              ].join("\r\n"),
          );
      }),
    );
  }
}
module.exports = { mountOperations, guide };
