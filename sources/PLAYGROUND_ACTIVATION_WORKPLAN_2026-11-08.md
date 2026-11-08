# Implementasi fungsi agen — 8 November 2026

Baseline backend `26a5891`, frontend `f917623`; perubahan pada feature branch `feat/agent-platform-20261103`, draft PR Playground #18 dan Agent-Frontend-Ui #10. Ruang deploy: service sandbox yang sudah digunakan, bukan produksi original.

## Fungsi yang diimplementasikan

| Fungsi | Jalur dashboard / frontend | Perilaku |
|---|---|---|
| Ringkasan lintas agen | Master Dashboard; Platform Agen → Semua agen | Membaca counts, journal penjualan/withdraw dan stok dari domain agency yang sama dengan panel agen. Tidak menjumlahkan mata uang/scale berbeda dan tidak mengaku sebagai rekening bank terverifikasi. |
| Brand/theme | Agen → Brand & kesiapan | Nama, upload logo/favicon, warna, version check; media harus benar-benar ada dan milik tenant. Website 64COR membaca manifest yang sama. Logo/favicon master juga mempunyai renderer di dashboard master. |
| Maintenance tenant | Brand & kesiapan | Menghentikan registrasi, deposit, bonus dan ronde baru di API. Riwayat, bantuan, penarikan dan settlement ronde yang sudah ada tetap tersedia. |
| Pemulihan password | Login → Lupa password; Pemulihan akun; Player / Staff & IP → Reset password | Operator harus mempunyai izin, mencatat verifikasi identitas, memasukkan password dan TOTP. Token di-hash, TTL 15 menit, sekali pakai, sesi dicabut, MFA tidak dihapus. Akun tidak dibocorkan pada respons permintaan anonim. |
| Ubah password staff | Brand & kesiapan → Keamanan akun saya | Password saat ini + TOTP, password baru 15–128 karakter, seluruh sesi dicabut. |
| Verifikasi email dan recovery otomatis | Profil player; Pemulihan akun → Pengiriman email | Adapter Resend opsional dan outbox durable terenkripsi. Hanya email verified dipakai untuk recovery. Perubahan email membatalkan token/antrean lama. Tanpa provider, operator recovery tetap tersedia. |
| Bonus tetap | Bonus kampanye → Kampanye bonus baru; frontend → Bonus | Anggaran dicadangkan dari stok, satu klaim/player/kampanye, waktu mulai/akhir, minimum total deposit credited, opsi pemain referral. Sisa dikembalikan saat kampanye ditutup. Reward tidak menjadi penjualan koin/invoice. |
| Referral | Brand & kesiapan → aktifkan Referral; frontend → Undang teman / formulir daftar | Kode acak, tenant-scoped, binding saat registrasi, hitung undangan dan pemain yang sudah deposit. Tidak memberi komisi uang otomatis. |
| Leaderboard | Brand & kesiapan → aktifkan; frontend → Leaderboard | Net pemain dari ronde settled bulan UTC ini, pseudonym stabil, tanpa membocorkan ID player atau memberi hadiah otomatis. |
| Pengumuman inbox | Pengumuman inbox → Pengumuman baru | Snapshot pemain aktif agen sendiri, idempotent, read receipt player. Bukan pengiriman email/SMS/Chatvice. |
| Aktivitas player | Frontend → Akun → Aktivitas | Registrasi/login/profil/password/bonus dari audit server, disertai transaksi agency; bukan histori lokal demo. |
| Rekonsiliasi | Agen / master-agent → Rekonsiliasi | Membandingkan saldo dengan sum journal, daftar ronde reserved dan pembayaran exception; tanpa auto-credit/auto-void. Belum rekonsiliasi statement bank/native provider. |
| Sitemap / robots | Frontend `/sitemap.xml`, `/robots.txt` | Rute published CMS, canonical pada origin sendiri, tidak memasukkan akun/private route. Sandbox/maintenance tidak diindeks. |
| Menu capability | Frontend dan master | Bonus/referral/leaderboard/provider tanpa kemampuan tidak ditawarkan sebagai menu aktif. Rancangan KYC/OAuth/custom CSS/dll masuk bagian teknis dan tidak lagi menyediakan toggle yang mengaku mengaktifkan runtime. |
| Game transport | Node/Python server adapter; signed `status` API | Redeem retry request ID sama mengembalikan sesi yang sama; reserve/settle idempotent; status saldo/ronde scoped untuk pemulihan respons jaringan. Tidak sama dengan pemasangan native adapter pada setiap game. |

## Aturan bonus yang dipilih untuk implementasi ini

Bonus adalah grant koin tetap, **tanpa wagering, free spins, cashback, komisi referral otomatis, atau clawback otomatis**. Dana berasal dari stok agen yang dicadangkan secara eksplisit oleh owner/master dengan step-up. Bonus dapat menjadi saldo tersedia sesuai aturan withdraw tenant. Agen wajib membaca definisi ini sebelum membuat kampanye; judul/syarat promo CMS tidak otomatis menjadi janji reward. Deposit minimum dihitung dari transaksi berstatus credited saat klaim. Refund kemudian tidak memotong bonus diam-diam. Fitur kampanye default kosong, referral dan leaderboard default nonaktif; tidak mengalokasikan saldo atau mengaktifkan promosi pelanggan dalam deployment.

## Batas yang belum selesai / belum aktif

1. **Native wallet UNO, Mahjong, Skygate belum dipasang pada jalur gameplay masing-masing repository.** Transport pusat dan tes signed-round tersedia, tetapi native local ledger/client math belum diganti. Readiness game deployed tetap Maintenance/registered. Temuan dan risiko ekonomi UNO dijelaskan pada dokumen handoff.
2. **Gateway pembayaran nyata belum diintegrasikan.** Belum ada provider/account/key di Railway. Seluruh cashier yang diuji tetap simulator; SHARED/SPLIT, approval, saldo dan reversal simulator tidak membuktikan UAT bank.
3. **Email adapter siap dikonfigurasi, delivery nyata belum diuji.** Tidak ada secret/domain pengirim. Status accepted bukan delivered; receipts webhook belum tersedia.
4. **SMS, KYC, Google/Apple OAuth belum diimplementasikan/diaktifkan.** Provider/account/callback dan aturan verifikasi belum dipilih. Tidak memberi badge Verified palsu.
5. **Lokalisasi seluruh CMS/UI, consent recording, attachment support, arsip audit, provider multi-game dan penagihan eksternal** belum ditambahkan. Menu rancangan tetap dapat ditinjau dari bagian teknis; tidak diklaim sebagai layanan aktif.

Batas ini sengaja dicatat sebagai pekerjaan tersisa, bukan diganti dengan status “selesai end-to-end”. Detail konfigurasi dan prasyarat: `AGENCY_PROVIDER_AND_NATIVE_GAME_HANDOFF_2026-11-08.md`.

## Validasi dan ruang pengujian

- Suite agency: 37 skenario pada PostgreSQL WASM/PGlite; backend dan frontend asli berjalan lokal; Chromium desktop/mobile.
- Tes termasuk double claim bersamaan, anggaran habis, pengembalian sisa, invoice tidak menghitung reward sebagai penjualan, tenant/role isolation, maintenance API, broadcast idempotency/read receipt, referral saat daftar, pseudonym leaderboard, expiry/single-use/session revocation/MFA recovery, mock email retry/encryption, dan Node/Python signed wallet clients.
- Browser menjalankan perubahan brand/upload logo dari panel agen hingga tampilan 64COR, pembuatan dan klaim bonus, pengumuman hingga inbox, aktivitas/referral, maintenance, serta reset password yang mencabut sesi frontend.
- Unit backend: 60 pass, 5 skip (native PostgreSQL integration suites terpisah). Unit frontend: 51 pass.
- Tidak memakai akun pelanggan, mengubah saldo deployed, mengirim email/pesan eksternal, atau mengirim transaksi bank pada QA.
- Bukti `sources/evidence/agency-activation-2026-11-08.json` dan `sources/evidence/activation-route-audit-2026-11-08.json`. Data test sintetis. Passing tests tidak setara dengan live UAT native game/provider.

## Kelanjutan yang memerlukan input dan integrasi

Playground menentukan provider merchant pembayaran dan credential sandbox; domain/email sender untuk aktivasi mail; spesifikasi KYC/SMS/OAuth bila digunakan. Untuk native games, tetapkan kontrak ekonomi dan satuan saldo dahulu, kemudian pasang adapter durable dalam tiap source, uji crash/retry lewat game asli dan deploy game sandbox terpisah. Tidak mengubah persentase payout atau memindahkan saldo lokal lama secara otomatis.
