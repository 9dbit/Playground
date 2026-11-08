# Aktivasi UNO native wallet — 8 November 2026

## Implementasi

UNO Orbit pada branch `feat/agency-native-wallet-20261108` sekarang dapat diluncurkan dengan token Playground, memakai saldo pusat, dan menyelesaikan satu ronde tiga kartu ke ledger agen/player. Intent, kartu, tier, payout, request ID dan phase disimpan di SQLite sebelum request jaringan. Saldo lokal tidak menjadi fallback. Sesi baru untuk tenant/player yang sama melanjutkan ronde tersimpan. Hadiah/refill/profil lokal dinonaktifkan pada service agen.

Ronde yang ditinggalkan selama 15 menit diselesaikan worker dengan hasil yang sudah tersimpan, termasuk kekalahan. Tidak ada refund selektif atau reroll saat timeout. Scope hanya sandbox, coin_scale 0, satu replica/worker dengan volume persisten. Odds game tetap asli; theoretical gross return 195.36% tidak cocok dianggap siap live tanpa keputusan ekonomi tersendiri.

Perbaikan backend: retry reservasi yang sudah tercatat tetap mengembalikan ronde sama meski session expired. Ronde baru dengan session expired tetap ditolak. Kunci native memakai variabel tambahan `AGENCY_NATIVE_GAME_KEYS`, sehingga kunci lama tidak perlu dibaca atau ditimpa.

## Katalog dan audit deployment

`AGENCY_SANDBOX_RELEASES` adalah manifest deployment eksplisit berisi `game`, `version` (40-character source SHA), `environment=sandbox`, `launch_url` HTTPS, dan `evidence`. Manifest hanya boleh diterapkan di namespace `agency_sandbox_*`, dengan key sandbox terkonfigurasi, tanpa tenant live, dan release yang memang sandbox. Update release dan status game diaudit dan dicatat sekali per source version. Restart berikutnya tidak membatalkan keputusan Maintenance yang dibuat operator. Entitlement/pilihan game per agen dan seluruh saldo tidak berubah oleh manifest.

## Validasi

- UNO: 117 pytest pass; guest regression dan native fault-injection.
- Playground: 38 skenario pass, mencakup browser native UNO, lease/idempotency, ledger reconciliation dan sandbox release guard.
- Backend unit: 60 pass, 5 skip khusus native PostgreSQL.
- Browser Chromium 393×852 menjalankan server FastAPI asli, wallet pusat asli dan DB terisolasi. Server UNO direstart setelah kartu pertama; kartu kedua/ketiga tetap ronde sama, satu settlement journal, ledger difference 0.
- Simulasi menggunakan PGlite dan saldo sintetis, bukan transfer bank atau akun pelanggan. Tidak ada native PostgreSQL load/concurrency certification maupun live economics certification.
- Bukti: `sources/evidence/uno-native-wallet-2026-11-08.json`.

## Deployment

- Source UNO: `9dbit/uno-luck`, draft PR #35.
- Source version: `1c2251c9275b5585a01c4f92c495b0371df97099`.
- Service: `uno-agency-sandbox`, URL `https://uno-agency-sandbox-production.up.railway.app`.
- Volume: `uno-agency-rounds`, `/data`, 512 MB. Image `Dockerfile.agency` menyiapkan ownership mount lalu turun permanen ke UID/GID 10001 sebelum menerima request.
- Startup dan health check memverifikasi database; nama Railway environment `production` tidak mengubah mode wallet sandbox.
- Buka melalui tombol Play di website agen setelah release terdaftar dan entitlement dipilih. URL game langsung tanpa token tidak memberi saldo demo atau akses player.

Status terminal deployment dan smoke test dicatat setelah deploy selesai. Mahjong/Skygate dan provider pembayaran, email delivery, SMS/KYC/OAuth tetap pekerjaan tersisa seperti dokumen handoff; tidak diklaim aktif oleh perubahan UNO ini.
