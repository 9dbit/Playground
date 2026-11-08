# Oxplay sebagai benchmark Playground

Tanggal: 8 November 2026. Sumber utama: [Oxplay onboarding guidebook](https://sites.google.com/idnplay.com/oxplayonboarding/update-log?authuser=0), dari file Sources proyek. Panduan digunakan untuk menilai kelengkapan workflow, bukan menyalin merek, aset, atau seluruh aturan bisnisnya.

## Prinsip pengembangan

- Selesaikan alur master → agen → pemain dengan status, aksi, hak akses, histori, dan hasil yang dapat diperiksa.
- Pertahankan website utama 64COR dan desain Playground. Jangan membuat website demo terpisah untuk fitur yang dapat disambungkan ke alur existing.
- Isolasi data per agen; otorisasi API tetap menentukan akses, bukan sekadar menu yang disembunyikan.
- Stok coin, wallet pemain, kas deposit/disbursement, dan pendapatan adalah catatan berbeda. Jangan menyebut selisih deposit/withdraw sebagai laba.
- Mutasi saldo harus atomik, idempoten, dan memiliki audit. Kredensial/otorisasi yang dicabut tidak boleh tetap mendanai refill.
- Cakupan rilis ini demo sandbox; tidak mengaktifkan rekening bank atau provider pembayaran nyata.

## Diterapkan dalam rilis benchmark pertama

| Area | Perubahan | Cara memakai |
|---|---|---|
| Pusat operasional | Jumlah request coin, pembayaran perlu review, tiket, draft konten, recovery, dan kampanye kedaluwarsa; terlihat sesuai role | Master memilih agen → Ringkasan; agen → Ringkasan |
| Request coin | ID pengajuan tetap saat retry; payload berbeda dengan ID sama ditolak | Agen → Request & riwayat coin → Request coin |
| Persetujuan coin | Approve/reject oleh master; penolakan membutuhkan alasan; approval ulang tidak menggandakan ledger | Master → pilih agen → Persetujuan & riwayat coin → Review |
| Refill | Nominal tetap 100 juta coin; mode Off, Request otomatis, atau Refill otomatis dengan otorisasi master | Atur auto refill; ambang, batas harian/bulanan, dan limit stok diperiksa |
| Kontrol refill | Status tenant/maintenance, request tertunda, cooldown penolakan 24 jam, owner aktif dan auth_version diperiksa | Status dan pemeriksaan terakhir tampil di kartu refill; worker demo perlu aktif |
| Histori | Pengaju, pemeriksa, sumber, waktu request/review/kredit, alasan dan saldo sebelum–sesudah | Filter tanggal, status, harian/mingguan/bulanan, urutan; ekspor CSV |
| Transaksi | Pencarian username/ID, jenis, status, rentang tanggal, urutan dan pagination | Deposit & Withdraw |
| Laporan | Arus kas dari journal termasuk koreksi; aktivitas game, settled stake/payout dan observed RTP | Laporan terpadu; ekspor transaksi sesuai tanggal |
| Panduan | Petunjuk coin/refill dan definisi tanggal tersedia di pusat bantuan | Bantuan |

Tanggal filter termasuk seluruh hari terakhir dalam Asia/Jakarta (WIB). Minggu mengikuti awal minggu PostgreSQL, Senin. Histori coin dikelompokkan menurut **tanggal pengajuan**, bukan tanggal kredit. Arus kas memakai tanggal journal. Ronde memakai tanggal settled, atau tanggal dibuat jika belum settled. Nilai laporan mengikuti unit minor tersimpan; coin_scale tersedia di API. CSV memakai timestamp ISO UTC, header eksplisit, dan perlindungan formula spreadsheet.

Histori lama dipertahankan. Record sebelum migrasi dapat tidak memiliki timestamp review/kredit maupun saldo sebelum–sesudah; UI menampilkan tanda kosong dan tidak mengarang data lama. Ringkasan dibatasi 1.000 periode dengan pemberitahuan jika terpotong; ekspor lebih dari 10.000 baris ditolak dengan permintaan mempersempit tanggal.

Refill otomatis **default nonaktif**. Agen boleh meminta otomatis atau menonaktifkan konfigurasi; hanya master Owner dengan password dan MFA yang berlaku dapat memberi otorisasi kredit otomatis. Nominal refill mengikuti coin_scale tenant. Batas harian/bulanan menghitung request otomatis non-rejected menurut waktu pengajuan WIB, termasuk yang masih pending. Aktivasi konfigurasi tidak menjalankan transfer bank. Worker yang sama dengan simulator sandbox memeriksa setiap dua detik. Penggantian password/versi autentikasi pemberi izin menahan refill sampai diberi otorisasi kembali.

## Fondasi existing yang dipertahankan

CMS draft/publish/rollback dan banner, pilihan game tenant, domain/canonical, bonus dengan budget, referral, inbox, tiket, profil pemain, pemulihan akun, staff/IP, rekonsiliasi, ledger dan koneksi frontend sudah ada. Rilis ini melengkapi operasi di atas fondasi tersebut; tidak mengklaim semua fitur panduan telah dibuat ulang.

## Backlog benchmark berikutnya

1. CMS dengan preview lintas perangkat, jadwal publikasi dan ringkasan perbedaan draft/published yang lebih jelas.
2. Halaman pemain terpadu dengan timeline lintas transaksi, sesi, bantuan dan aktivitas, tetap sesuai role.
3. Workflow onboarding agen yang menggabungkan domain, konten, game dan status kesiapan frontend.
4. Zona waktu dan mata uang per operator, setelah definisi bisnis ditetapkan; rilis ini mempertahankan WIB agar sesuai laporan existing.
5. Integrasi provider live, Live Casino nyata dan persyaratan operasional yurisdiksi melalui proyek terpisah setelah kebutuhan dan provider ditentukan. Menu demo bukan bukti integrasi live.

## Verifikasi

- `npm test`: unit dan database terisolasi, termasuk migrasi berulang, request/review bersamaan, kegagalan audit/rollback, batas refill, tenant isolation, otorisasi dicabut, tanggal WIB dan CSV.
- `npm run test:agency`: HTTP server dan database terisolasi; otorisasi master dengan password/MFA nyata dalam fixture, pemisahan role, worklist dan ekspor.
- `AGENCY_BROWSER=true STOREFRONT_PATH=<checkout frontend> npm run test:agency`: browser memakai backend lokal nyata, termasuk website 64COR jika path diberikan.
- `node tests/agency-operations-ui.cjs`: aset asli dengan API fixture pada 1440/393/320 px; filter, request retry, field otorisasi master, pembatasan agen dan overflow.
- Navigasi dan pemulihan sesi: `tests/panel-navigation-ui.cjs`, `tests/panel-account-ui.cjs`.

Pengujian lokal memakai PostgreSQL WASM (PGlite) bila TEST_DATABASE_URL tidak ada. CI menjalankan unit dan alur bisnis dengan PostgreSQL 18. Bukti lokal bukan verifikasi akun production atau transaksi riil. Deployment harus dilaporkan terpisah berdasarkan status Railway dan commit yang benar.

## Hasil aktual rilis ini

- Unit/database lokal: **77 lulus, 5 dilewati, 0 gagal**. Lima pengujian yang dilewati membutuhkan PostgreSQL native; belum dijalankan di CI untuk perubahan ini.
- Suite HTTP + browser dengan checkout frontend `4cec630`: **39 skenario lulus, 0 gagal**, menggunakan database lokal terisolasi. Termasuk CMS ke frontend, bonus, inbox, aktivitas, maintenance, recovery, semua menu master/agen dan preview referral di website utama.
- Browser fixture operasi: **1440/393/320 px lulus**. Fixture navigasi dan pemulihan sesi juga lulus.
- Referral pada frontend terbaru tetap preview demo sesuai implementasi existing. Uji menegaskan tab Harian/Mingguan/Bulanan dan label data contoh; tidak mengklaim komisi/referral live aktif.
