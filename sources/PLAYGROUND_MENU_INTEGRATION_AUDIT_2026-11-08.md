# Audit menu, navigasi, dan integrasi Playground — 8 November 2026

## Kesimpulan

**Belum semua fitur layak untuk operasional produksi.** Navigasi dan alur agen yang tersedia bekerja dalam sandbox, tetapi beberapa menu master menggunakan domain data GameOps yang berbeda dari domain agen. Halaman yang terbuka bukan bukti pembayaran, game, verifikasi identitas, atau pengiriman pesan eksternal sudah aktif.

Audit mencakup source frontend/backend, browser dengan database terisolasi, dan manifest publik 64COR. Tidak mengubah saldo, akun, atau konten pelanggan pada deployment. Akun master/agen live tidak dipakai untuk QA autentikasi; sesi browser pengujian memakai akun sintetis lokal.

## Perbaikan pada pekerjaan ini

- Tombol **← Kembali** dan **☰ Menu utama** menggunakan komponen dan gaya yang sama: pill, area tap minimal 44 px, fokus keyboard, menu dialog yang dapat ditutup. Ada di master utama, pengelolaan agen, panel agen, Game Bridge, Game Data, Source Wallet dan engine lama.
- Menu utama master mencantumkan seluruh kelompok menu dan pengaturan. Menu utama agen mengambil menu yang diizinkan oleh role; tidak memberi jalan ke menu master. Tombol kembali agen menuju ringkasan agennya, tombol kembali master menuju dashboard master.
- Platform Agen, Game Bridge, Game Data dan Source Wallet menjadi entri utama sidebar; pemasangan tautan lama tidak menghasilkan duplikat.
- Perbaikan rute pencarian Manage Users, Report, Extra; editor Templates/Pages/Frontend/Policies diarahkan ke editor konten yang benar.
- Halaman GameOps yang berpotensi tertukar dengan operasional agen menampilkan penjelasan cakupan dan tautan ke Platform Agen.
- Status Cron yang masih menyatakan tidak ada scheduler diperbaiki: runner pembersihan sesi lokal memang sudah tersedia, bukan worker pembayaran.
- Halaman Tentang Kami dan kebijakan 64COR kini membaca **published CMS agen**. Tanpa publikasi, tampil keterangan belum dipublikasikan, bukan klaim template lama yang menyebut data hanya disimpan di browser.
- Metadata halaman CMS memakai judul, deskripsi dan canonical halaman masing-masing; canonical home tidak dipaksakan ke halaman dalam. Meta robots/canonical ganda dibersihkan.

## Alur operasional yang benar

Master Playground → Platform Agen → pilih agen → menu agen. Semua menu dalam konteks agen menggunakan tenant yang dipilih. Agen login melalui `/agency?tenant=64cor` dan hanya mengakses data/izin agennya. Frontend 64COR menggunakan manifest publik dan API player yang terikat ke tenant 64COR.

Master GameOps mengelola katalog dan pengamatan sumber game. Tabel `gameops_players`, ledger demo, tiket dan CMS GameOps **tidak identik** dengan `agency_players`, ledger agen, tiket agen dan CMS agen. Menggabungkan tabel hanya karena namanya sama dapat menggandakan saldo atau salah mengaitkan identitas pemain; diperlukan pemetaan identitas serta rekonsiliasi eksplisit.

## Menu master: hubungan, kondisi, dan keputusan

| Menu/submenu | Hubungan ke agen/frontend | Kondisi dan keputusan |
|---|---|---|
| Dashboard | KPI GameOps; bukan total operasional semua agen | Berfungsi untuk data sumber/legacy. Pertahankan sebagai monitor teknis; perlu ringkasan lintas agen terpisah dengan label sumber. |
| Platform Agen | Pusat pengelolaan tenant, staff, stok, CMS dan transaksi | Terhubung langsung. Jadikan jalur utama operasional agen. |
| Manage Games → Games, detail/edit | Katalog `gameops_games` dipakai pilihan game agen | Katalog terhubung; field demo chance/win amount bukan kontrol runtime native. Pertahankan katalog, pisahkan/labeli konfigurasi demo. |
| Manage Games → Game Log, per-game/player log, detail ronde | Observasi GameOps berbeda dari `agency_rounds` | Pertahankan untuk debugging sumber; perlu korelasi round ID dan player ID sebelum dijadikan laporan saldo agen. |
| Game Bridge / Connections | Transport, heartbeat, observasi bertanda tangan | Fondasi teknis aktif. Heartbeat bukan bukti ronde lengkap atau wallet settled. Pertahankan untuk verifikasi adapter. |
| Game Data / Reconciliation | Data source-scoped dan environment-scoped | Penting untuk audit selisih; belum satu ledger dengan agen. Pertahankan, implementasikan pemetaan dan rekonsiliasi. |
| Source Wallet / Diamond Requests | Pilot wallet sumber UNO, terpisah dari wallet agen | Bukan kasir agen. Pertahankan dalam menu teknis/pilot, jangan dipakai untuk kredit player 64COR. |
| Manage Users → Active/Banned/All, detail | Pemain/pseudonym GameOps, bukan akun `agency_players` | Daftar dan perubahan lokal tersedia; ban lokal tidak otomatis memblokir akun/game agen. Pertahankan sebagai diagnostik, beri label sumber; operasi agen melalui Platform Agen → Player. |
| Manage Users → Email/Mobile Unverified | Tidak ada provider verifikasi yang tersambung | Tampilan/filter bukan proses verifikasi. Sembunyikan dari kerja harian sampai OTP/email delivery, expiry, retry, audit dan status konsisten tersedia. |
| Manage Users → KYC Unverified/Pending | Belum ada intake bukti dan provider/workflow verifikasi | Pertahankan rancangan teknis bila dibutuhkan onboarding; jangan tampilkan status Verified tanpa bukti. Bukan fitur aktif. |
| Send Notification; Notification History | Rekaman internal GameOps; bukan inbox agen/Chatvice | Belum email/SMS/push. Pertahankan log, aktifkan pengiriman hanya setelah provider, queue, retry, receipts dan preferensi penerima tersedia. |
| Diamond Requests → Pending/Approved/Rejected/All | Metadata request legacy, tidak mengalokasikan stok agen | Persetujuan tidak mengkredit saldo. Pindahkan ke kelompok legacy/teknis; untuk agen gunakan Stok koin. Tidak perlu mempertahankan dua kasir aktif. |
| Support Ticket → Pending/Closed/Answered/All, detail/reply | Tiket GameOps terpisah dari tiket player/agen | CRUD lokal tersedia. Gunakan sebagai support platform bila ada kebutuhan; tiket operasional 64COR ada di Bantuan agen. Integrasi lintas inbox perlu routing tenant yang jelas. |
| Report → Transaction History/Win/Loss/Draw | Ronde/ledger virtual GameOps, bukan pembayaran agen | Pertahankan laporan sumber; laporan agen harus mengambil agency ledger dan membedakan bet/payout dari deposit/withdraw. |
| Report → Login History | Riwayat login admin; berbeda dari IP/fingerprint player agen | Pertahankan untuk keamanan master. Data perangkat player sudah berada di Player → Detail pada konteks agen. |
| Report → Transfer History; Player → Virtual Wallet | Transfer DEMO_COIN internal, tidak menyinkron wallet native/agen | Berguna untuk QA ledger, jangan disamakan dengan bank transfer atau coin stock agen. Tempatkan dalam teknis/demo. |
| Subscribers | Daftar lokal tanpa mailing pipeline | Tidak diperlukan untuk operasi inti 64COR saat ini; sembunyikan sampai ada opt-in, unsubscribe, delivery dan kebijakan retensi. |
| Report & Request | Membuat tiket internal GameOps | Duplikasi pintu masuk Support Ticket. Bisa dipertahankan sebagai shortcut dengan label jelas, atau digabung; tidak perlu workflow kedua. |
| Extra → Application/Server | Metadata/health baca-saja | Berfungsi untuk diagnosa, bukan kontrol deploy/infra. Pertahankan khusus master. |
| Extra → Cache/Update | Tidak ada engine invalidasi cache/update terverifikasi | Pertahankan sebagai informasi teknis saja atau sembunyikan tombol tindakan. Deploy tetap melalui pipeline yang diuji, bukan tombol yang tidak melakukan apa-apa. |
| Functional QA | Inventaris status implementasi, sebagian deskripsi historis | Pertahankan untuk tracking, bukan bukti bahwa semua fitur sudah lolos. Cron diperbarui; perlu terus disesuaikan dengan bukti pengujian. |
| Security Center; Administrator Profile | Login master, MFA, session, profil | Berfungsi untuk akun master. Tidak boleh berbagi sesi atau hak akses dengan agen. Pertahankan terpisah. |
| Notification Center | Per-admin read/unread atas audit lokal | Berfungsi dalam cakupannya, belum notifikasi kejadian agen menyeluruh. Pertahankan dan tambah event tenant jika dashboard master ingin memonitor agen. |
| Cron Setup | Manual/terjadwal cleanup sesi kedaluwarsa | Berfungsi untuk maintenance lokal. Worker transaksi/scheduler CMS agen berbeda. Pertahankan; jangan menamai semua job bisnis sebagai job ini. |

## Seluruh System Setting master

| Menu | Efek aktual / hubungan | Pertahankan atau tindak lanjut |
|---|---|---|
| General Setting | Judul/warna admin sebagian diterapkan; bonus/charge hanya konfigurasi | Pertahankan identitas master. Bonus/charge perlu engine ledger; tidak mengubah brand 64COR. |
| Logo and Favicon | Metadata URL tersimpan; tidak mengganti seluruh aset aplikasi/agen | Perlu consumer rendering. Brand agen harus tenant-scoped, bukan global overwrite. |
| System Configuration | Pengaturan tersimpan; flag tertentu tidak mempunyai consumer | Pertahankan yang punya efek terbukti; nonaktifkan/labeli toggle tanpa efek. |
| Notification Setting | Preferensi tersimpan, provider delivery belum ada | Pertahankan sebagai konfigurasi setelah pipeline disiapkan. |
| SEO Configuration | Metadata master; bukan CMS SEO agen | Operasional 64COR melalui Website & SEO. Hindari dua menu yang mengaku mengatur website yang sama. |
| Manage Templates | CRUD/versioning template; renderer template belum tersambung | Simpan sebagai draft teknis, sembunyikan dari operator sampai renderer tersedia. |
| Manage Pages | Publikasi halaman teks `/info/page/...` GameOps | Berfungsi untuk dokumen platform, bukan halaman 64COR. Pertahankan dengan label platform. |
| Manage Frontend | Rekaman slot konten GameOps, tidak dibaca 64COR | Migrasi penggunaan ke CMS agen; tidak perlu dua sumber untuk banner yang sama. |
| KYC Setting | Konfigurasi, bukan pipeline verifikasi | Tunggu workflow yang disebut di audit KYC. |
| Social Login Setting | Google/Apple belum OAuth aktif | Sembunyikan toggle aktivasi sampai callback, secret, account linking dan recovery selesai. |
| Language | Preferensi tersimpan; belum semua UI diterjemahkan | Pertahankan jika diperlukan lokalisasi; implementasikan resource terpusat dan fallback. |
| Extensions | Tidak ada runtime ekstensi | Untuk widget chat cukup Chatvice. Jangan menyediakan pemasangan provider chat umum. Ekstensi lain hanya jika ada kebutuhan dan desain runtime. |
| Cron Job Setting | Mengatur cleanup lokal | Berfungsi; label lama diperbaiki. Bukan setting settlement pembayaran. |
| Policy Pages | Publikasi `/info/policy/...` GameOps | Pertahankan untuk kebijakan platform. Kebijakan 64COR memakai CMS agen dan slug di bawah. |
| Maintenance Mode | Berlaku pada informasi publik GameOps | Tidak menutup game native/64COR secara universal. Perlu kebijakan maintenance tenant terpisah sebelum mengklaim global switch. |
| GDPR Cookie | Teks/flag tersimpan; belum consent recording/revoke | Pertahankan rancangan bila digunakan; perlu UI consent, penyimpanan bukti dan penerapan pilihan pada script. |
| Custom CSS | Draft disimpan; tidak dieksekusi | Tidak wajib diaktifkan. Utamakan theme token terkontrol; arbitrary CSS bukan kebutuhan operasional inti. |
| Sitemap XML | Sitemap halaman informasi GameOps | Tidak mewakili seluruh frontend 64COR. Perlu sitemap agen per-route dan deployment domain yang benar. |
| Robots txt | Endpoint GameOps memakai konfigurasi | Tidak otomatis mengubah robots frontend 64COR. Sandbox tetap noindex. |

## Seluruh menu agen

| Menu | Hubungan dan status | Batas/tindak lanjut |
|---|---|---|
| Panduan operasional | Bantuan berdasarkan role/tenant, konfigurasi Chatvice | Aktif; private Chatvice SSO/lookup otomatis belum ada. |
| Ringkasan | Saldo/count agency tenant | Aktif sandbox. Bukan saldo rekening bank yang ditarik dari gateway live. |
| Player → Detail | Akun, balance, hasil ronde, perangkat | Terhubung ke registrasi frontend. Win/lose dari settled agency rounds. Fingerprint sinyal sesi; bukan identitas hardware. |
| Deposit & Withdraw | Transaksi frontend dan ledger agen yang sama | Alur simulasi auto/manual/approval diuji. Gateway live/disbursement dan rekonsiliasi settlement eksternal belum terhubung. |
| Stok koin | Request agen, review/alokasi master, stok untuk kredit player | Alur tersedia. Jangan samakan dengan Diamond Requests legacy. |
| Game pilihan | Entitlement master + pilihan agen membentuk katalog frontend | Terhubung. Launch native masih diblokir readiness hingga integrasi wallet selesai. |
| Website & SEO | Draft/publish/rollback, banner, promo, Chatvice, domain | Banner/promo/home terhubung. Info/kebijakan dan SEO per halaman diperbaiki pada audit ini. Branding global, sitemap/robots frontend dan seluruh template belum dikontrol penuh. |
| Staff & IP | Akun email, role, IP allowlist, session revocation | Aktif. Owner/supervisor memakai MFA sesuai aturan. UI pemulihan password agen mandiri belum lengkap; jangan menjanjikan reset email otomatis. |
| Aturan withdraw | Threshold dan aturan pemrosesan agency cashier | Aktif di simulator; kondisi saldo disbursement nyata menunggu gateway. |
| Analitik | Aggregate agency rounds/transactions | Aktif pada data yang sudah masuk. Periode/filter lebih lanjut dan gabungan lintas provider memerlukan perluasan. |
| Invoice | Close period, basis gross/net, tarif kontrak, pencatatan pembayaran | Diuji pada saldo dan periode sintetis. Integrasi pembukuan/penagihan eksternal belum ada. |
| Bantuan | Tiket player → admin agen → balasan inbox player | Terhubung dan diuji lintas repo. Lampiran, push/email delivery dan sinkronisasi percakapan Chatvice belum ada. |
| Audit | Catatan aksi staff, CMS, ledger/approval | Aktif tenant-scoped. Perlu kebijakan retensi/arsip dan monitoring operasional untuk produksi. |

## Frontend 64COR

| Menu/kelompok | Kondisi |
|---|---|
| Beranda, Cari, katalog Soft Tech, detail game | Manifest game dan banner published dibaca. Preview video/aset ada; Play mengikuti status/readiness. Ketiga game live masih Maintenance/registered. |
| Promosi | Konten terhubung CMS `promo-*`; tombol klaim tidak memberikan bonus. Mesin kelayakan, batas, wagering/reversal dan posting ledger belum ada. |
| Akun/Informasi | Registrasi/login, profil, password saat masih login, preferensi/favorit terhubung. |
| Deposit, Withdraw, Riwayat transaksi | API player tenant-scoped. Pembayaran nyata belum tersedia; simulator bukan gateway live. |
| Riwayat bermain | `agency_rounds`; tidak mengimpor otomatis seluruh histori source GameOps lama. |
| Inbox/Bantuan/Contact/Complaint | Tiket dan balasan terhubung; inbox ini bukan kampanye email/SMS/push. |
| Bonus, Referral, Leaderboard | Menampilkan belum aktif. Pertahankan hanya sebagai backlog/capability nonaktif, atau sembunyikan dari navigasi publik sampai mesin perhitungannya siap. |
| Aktivitas akun | Belum timeline lengkap aktivitas player. Tidak boleh disamakan dengan Audit staff atau ronde game. |
| Lupa password | Mengarahkan dukungan, belum reset token email otomatis. Perlu mekanisme identitas, expiry/single-use, rate limit, revoke sesi dan alur operator terotorisasi. |
| Tentang Kami / kebijakan | Kini memakai CMS published; bila belum ada konten, tampil belum dipublikasikan. Agen perlu menulis konten final, bukan memublikasikan template sebagai kebijakan nyata. |
| Sports/Lotto/Poker/Fishing/SNS/Exclusive | Dinonaktifkan pada connected mode. Jangan tampilkan sebagai layanan aktif sampai ada provider dan adapter. |
| Casino/Arcade/provider selain Soft Tech | Tidak tersedia jika katalog entitlement kosong; belum integrasi multi-provider lengkap. |
| Bahasa | Pilihan UI lokal ada; bukan seluruh terjemahan CMS yang dikontrol setting bahasa master. |
| Chatvice | Embed resmi → Merchant ID → publish → widget asli. Tidak menjalankan arbitrary script/provider chat lain. |

Slug CMS halaman 64COR: `home`, `banner-*`, `promo-*`, `about-us`, `responsible-gaming`, `terms-and-conditions`, `privacy-policy`. Empat slug informasi terakhir dipetakan ke URL yang sudah ada, termasuk `/legal/privacy-policy`. Konten harus disimpan dan dipublikasikan; mengubah draft tidak mengubah website.

## Alasan mempertahankan fitur belum selesai

Tidak semua menu wajib dipertahankan di navigasi harian. Katalog, rekonsiliasi, audit, stok, kasir, billing, dan keamanan adalah fondasi yang perlu diselesaikan. Menu provider seperti KYC/OAuth/OTP/payment perlu tetap nonaktif sampai ada koneksi nyata. Demo wallet/Diamond Requests lama sebaiknya masuk kelompok teknis, bukan kasir alternatif. Subscribers, template runner, custom CSS, cache/update dan referral/leaderboard bisa disembunyikan sampai ada kebutuhan dan kriteria penerimaan; keberadaan tombol bukan alasan mengaktifkannya.

## Prioritas berikutnya dan kriteria selesai

1. **P0 — konsistensi UI/navigasi dan cakupan data:** selesai dalam perubahan ini untuk tombol kembali/menu utama, rute pencarian dan label cakupan; desain seluruh halaman master/agen belum disatukan total.
2. **P1 — pemetaan identitas dan wallet game native:** signed launch/redeem/reserve/settle/void tiap game, idempotency/replay, disconnect recovery, rekonsiliasi serta hasil saldo konsisten. Jangan mengaktifkan Play hanya dengan mengganti status registry.
3. **P1 — gateway nyata:** akun merchant, SHARED/SPLIT, webhook terverifikasi, idempotency, rekening disbursement, statement/settlement/reversal serta UAT nominal terbatas. Memerlukan provider dan akun yang dipilih Playground.
4. **P1 — operasi pemain dan recovery:** reset terotorisasi, status suspend yang diterapkan saat login/launch, notifikasi dan bukti identitas; halaman dukungan saja belum menyelesaikan recovery.
5. **P2 — ringkasan master lintas agen:** baca ledger/report tenant yang sama dengan panel agen, agregasi tanpa double-count; tetap pisahkan observasi sumber.
6. **P2 — CMS penuh dan metadata:** brand/logo/theme, konten per bahasa, sitemap/robots dan canonical per domain. Konten kebijakan tetap harus diberikan/disetujui pemilik.
7. **P2/P3 — bonus/referral/leaderboard, broadcast, KYC/OAuth:** kerjakan setelah definisi bisnis/provider tersedia dan jalur core terbukti. Nonaktifkan menu layanan yang belum tersedia pada navigasi publik.

## Bukti pengujian dan batas klaim

- 30 skenario agency lulus pada PostgreSQL WASM/PGlite dan Chromium. Mencakup transaksi simulasi, pemisahan tenant/role, ledger, CMS, banner, embed Chatvice dan email login.
- Cross-repository QA menjalankan backend Playground dan server frontend 64COR aktual dengan database terisolasi: registrasi, profil, deposit request, publish banner/metadata, publish dan render kebijakan yang di-escape, tiket bantuan.
- Audit browser 91 rute/tampilan: 53 master, 13 master dalam konteks agen, 13 Owner Agen dan 12 frontend. Ini bukti render/navigasi tanpa error halaman, **bukan 91 pengujian mutasi bisnis lengkap**. Enam halaman modul master lain juga dimuat dalam QA widget sebelumnya pada suite yang sama.
- Tes unit master: 60 pass, 5 skip (integration suites memerlukan native PostgreSQL/config terpisah); tidak disebut 65 lulus.
- Tes frontend: 50 pass, 0 fail.
- Manifest publik 64COR pada waktu audit: 34 konten, gateway `simulation`, bonus/referral/leaderboard `false`; UNO LUCK, Mahjong Wild, Skygate 5000 berstatus `Maintenance` dan readiness `registered`.
- Bukti route runtime: `sources/evidence/menu-route-audit-2026-11-08.json`. Screenshot uji lokal tersimpan dalam test-results; bukan screenshot autentikasi produksi.
- Ruang perubahan deployment: feature branch/draft PR dan service sandbox yang sudah digunakan. Produksi Playground original tidak diganti. Laporan ini bukan persetujuan untuk memindahkan uang, mengaktifkan gateway, atau melepas readiness gate game.

## Peta source untuk reviewer

- Master route/sidebar/search: `public/control.js`; menu bersama: `public/platform-navigation.js` dan `.css`.
- Master legacy APIs: `engine/deep-routes.js`, `engine/admin-operations.js`, `engine/public-content.js`, `engine/virtual-wallet.js`.
- Observasi/sumber: `engine/game-bridge.js`, `engine/game-data.js`, `engine/source-wallet.js`.
- Agen/ledger/CMS: `engine/agency/index.js`, `cashier.js`, `games.js`, `billing.js`, `content.js`, `operations.js`.
- Frontend repo: `public/playground.js`, `public/app.js`, `public/content-routes.js`, `storefront-seo.mjs`, `storefront-proxy.mjs`.
