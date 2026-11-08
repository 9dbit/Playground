# Aktivasi UNO native wallet — 8 November 2026

## Implementasi

UNO Orbit pada branch `feat/agency-native-wallet-20261108` sekarang dapat diluncurkan dengan token Playground, memakai saldo pusat, dan menyelesaikan satu ronde tiga kartu ke ledger agen/player. Intent, kartu, tier, payout, request ID dan phase disimpan di SQLite sebelum request jaringan. Saldo lokal tidak menjadi fallback. Sesi baru untuk tenant/player yang sama melanjutkan ronde tersimpan. Hadiah/refill/profil lokal dinonaktifkan pada service agen.

Ronde yang ditinggalkan selama 15 menit diselesaikan worker dengan hasil yang sudah tersimpan, termasuk kekalahan. Tidak ada refund selektif atau reroll saat timeout. Scope hanya sandbox, coin_scale 0, satu replica/worker dengan volume persisten. Odds game tetap asli; theoretical gross return 195.36% tidak cocok dianggap siap live tanpa keputusan ekonomi tersendiri.

Perbaikan backend: retry reservasi yang sudah tercatat tetap mengembalikan ronde sama meski session expired. Ronde baru dengan session expired tetap ditolak. Kunci native memakai variabel tambahan `AGENCY_NATIVE_GAME_KEYS`, sehingga kunci lama tidak perlu dibaca atau ditimpa.

## Katalog dan audit deployment

`AGENCY_SANDBOX_RELEASES` adalah manifest deployment eksplisit berisi `game`, `version` (40-character source SHA), `environment=sandbox`, `launch_url` HTTPS, dan `evidence`. Manifest hanya boleh diterapkan di namespace `agency_sandbox_*`, dengan key sandbox terkonfigurasi, tanpa tenant live, dan release yang memang sandbox. Update release dan status game diaudit dan dicatat sekali per source version. Restart berikutnya tidak membatalkan keputusan Maintenance yang dibuat operator. Entitlement/pilihan game per agen dan seluruh saldo tidak berubah oleh manifest.

## Validasi

- UNO: 118 pytest pass; guest regression dan native fault-injection.
- Playground: 38 skenario pass, mencakup browser native UNO, lease/idempotency, ledger reconciliation dan sandbox release guard.
- Backend unit: 60 pass, 5 skip khusus native PostgreSQL.
- Browser Chromium 393×852 menjalankan server FastAPI asli, wallet pusat asli dan DB terisolasi. Server UNO direstart setelah kartu pertama; kartu kedua/ketiga tetap ronde sama, satu settlement journal, ledger difference 0.
- Simulasi menggunakan PGlite dan saldo sintetis, bukan transfer bank atau akun pelanggan. Tidak ada native PostgreSQL load/concurrency certification maupun live economics certification.
- Bukti: `sources/evidence/uno-native-wallet-2026-11-08.json`.

## Deployment

- Source UNO: `9dbit/uno-luck`, draft PR #35.
- Source version: `a46fa7b36cc54c9cba60a9361432f0ebe076d746`.
- Service: `uno-agency-sandbox`, URL `https://uno-agency-sandbox-production.up.railway.app`.
- Volume: `uno-agency-rounds`, `/data`, 512 MB. Image default `Dockerfile` (guest/sandbox mode) menyiapkan ownership mount lalu turun permanen ke UID/GID 10001 sebelum menerima request.
- Startup dan health check memverifikasi database; nama Railway environment `production` tidak mengubah mode wallet sandbox.
- Buka melalui tombol Play di website agen setelah release terdaftar dan entitlement dipilih. URL game langsung tanpa token tidak memberi saldo demo atau akses player.

Deployment UNO `e8f12939-d983-4472-9fe1-f039f1f81da7` sudah SUCCESS. Health publik HTTP 200 menampilkan `wallet=playground`, `mode=sandbox`, `database=connected`, dan source commit di atas. `/api/agency/state` tanpa launch menolak 401; endpoint wallet guest menolak 403. Katalog storefront deployed 64COR menampilkan UNO `Active/publishable`; Mahjong/Skygate masih `Maintenance/registered`.

UAT deployed melalui API storefront menggunakan satu akun sintetis sandbox (identitas akun tidak dimuat dalam dokumen publik): registrasi → launch → native redeem → state wallet berhasil, saldo/reserved nol, daily/refill nonaktif. Tidak ada deposit, withdraw atau paid round pada akun deployed tersebut. Bukti: `sources/evidence/uno-native-deployed-2026-11-08.json`. Browser berbayar simulasi dijalankan pada DB terisolasi; storefront 64COR asli → tombol Play → native tiga kartu → kembali ke website dengan saldo pusat yang sama. Bridge hostname HTTPS pada harness meneruskan seluruh request ke FastAPI lokal, tanpa mengganti respons game atau wallet.

Mahjong/Skygate dan provider pembayaran, email delivery, SMS/KYC/OAuth tetap pekerjaan tersisa seperti dokumen handoff; tidak diklaim aktif oleh perubahan UNO ini.

## Sisa integrasi native

Mahjong memakai stake 0.2/0.5/1/2/5/10 dan math dengan payout Decimal hingga 12 digit; paytable scale memiliki lebih dari 12 digit. Konversi ke `coin_scale=0` milik agen tidak boleh dilakukan dengan pemotongan desimal tersembunyi. Diperlukan kontrak satuan/pembulatan yang eksplisit sebelum gameplay memakai saldo agen. Skygate masih membuat hasil di browser dengan RNG seeded: perlu dipindahkan ke server, menyimpan konfigurasi/outcome per ronde, lalu memasang settlement durable. Keduanya belum diberi status publishable.
