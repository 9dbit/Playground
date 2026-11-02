# Playground CP13: Audit Source dan Backend

## Kesimpulan

**AUDIT SELESAI DENGAN TEMUAN TERBUKA. Bukan full functional parity.**

Baseline yang diaudit: main `3e9dad5f010aa830ba4930d1d85cd793c25deb2c`, aplikasi v0.12.0. Audit menjalankan **server.js lengkap**, bukan sekadar router terpisah, melalui HTTP dengan middleware asli dan PostgreSQL CI terisolasi.

| Ukuran | Hasil |
|---|---:|
| Source backend yang hash-nya diverifikasi | 8 berkas |
| Deklarasi route literal, tidak termasuk aset dinamis | 83 |
| Tes regresi existing | 74 lulus, 0 gagal, 0 dilewati |
| Skenario kontrol tambahan lulus | 8 |
| Bug yang direproduksi | 8: tiga P1, lima P2 |
| Kesenjangan integrasi terobservasi | 1 |
| Error harness audit | 0 |
| Perubahan source runtime/produksi oleh audit ini | 0 |

CI audit final: https://github.com/9dbit/Playground/actions/runs/41501529526
Draft PR: https://github.com/9dbit/Playground/pull/11
Artifact: `cp13-backend-audit-evidence`, ID `13167953998`.
Artifact SHA256: `e1b3fbe79351acbe5ba1bc284ee5468b86824b290167a5c19fef2f0ac752dfdf`.
Eksekusi selesai: `2026-11-02T18:33:05.509Z`.

Keberhasilan job audit berarti bukti reproduksi terkumpul, bukan berarti produk bebas bug. Semua request memakai localhost dan data sintetis; tidak ada penulisan database, akun, MFA, kunci bridge, atau konfigurasi Railway produksi.

## Koreksi terhadap klaim CP12

Handler Game Log baru memang sudah ada, tetapi handler lama di server.js dipasang terlebih dahulu. Akibatnya, filter dan pagination baru tidak efektif melalui server lengkap. Tes modul CP12 dan browser mock tidak mencakup urutan route sesungguhnya. Klaim sebelumnya bahwa fitur tersebut sudah aktif penuh perlu dikoreksi.

## Temuan terkonfirmasi

### F01 / P1: Game Log tertutup route lama
- Sumber: `server.js:143-148`, pemasangan `deep.mount` pada baris 205, dan `engine/deep-routes.js:122-129`.
- Request `result=win&limit=1&page=2` mengembalikan HTTP 200 dengan **8** event campuran, termasuk payout nol, tanpa metadata pagination.
- Solusi: satu handler kanonis, hapus duplikasi lama, dan test HTTP pada server lengkap. Registrasi ganda System Information juga terinventarisasi, tetapi tidak dihitung sebagai defect tambahan tanpa dampak yang diuji.

### F02 / P2: Validasi System Settings terlalu umum
- Sumber: `server.js:187-193`.
- `per_page=-10`, `register_bonus=-500`, `transfer_percent=101`, timezone dan warna invalid diterima HTTP 200 dan tersimpan.
- Skenario dilakukan oleh owner sah, bukan bypass izin. Perlu schema, tipe, rentang dan allowlist field untuk setiap modul.

### F03 / P2: Settings mengabaikan versi form
- Dua request memakai versi 1. Keduanya sukses HTTP 200, versi database menjadi 3 dan perubahan penulis kedua menimpa penulis pertama.
- Perlu conditional update dengan expected_version/ETag dan HTTP 409 untuk form kedaluwarsa, beserta dukungan UI.

### F04 / P1: Data bisnis tersimpan saat audit gagal
- Sumber: `engine/deep-routes.js:78-100`, `server.js:187-193`, `engine/admin-operations.js:126-136`.
- Trigger khusus CI membuat audit insert gagal. Game Configuration, General Settings dan own profile mengembalikan HTTP 500, namun perubahan tetap tersimpan.
- Perlu satu transaksi/koneksi untuk perubahan bisnis dan audit. Wallet virtual diuji terpisah dan **sudah rollback dengan benar** pada kegagalan audit; jangan menggeneralisasi temuan ini ke wallet.

### F05 / P1: Banned Users melewatkan data lama
- Sumber: `engine/deep-routes.js:130-135`.
- Query LIMIT 200 dijalankan sebelum filter status di JavaScript. Satu pemain blocked_locally yang lama tidak muncul setelah ada 205 pemain aktif lebih baru.
- Perlu filter SQL sebelum pagination, total yang sesuai filter, urutan stabil dan validasi state. Ini adalah status lokal, bukan blokir game eksternal.

### F06 / P2: Author balasan tiket selalu admin
- Sumber: `engine/deep-routes.js:183-189`.
- `audit_support` mengirim balasan, tetapi message.author tersimpan sebagai `admin`. Audit aktivitas terpisah tetap mempunyai konteks aktor.
- Simpan identitas administrator dari request. Jangan menebak identitas historis pesan lama.

### F07 / P2: Page dan Policy berbagi URL yang ambigu
- Sumber: constraint `UNIQUE(kind,slug)` di `engine/deep-routes.js:20`, sitemap pada 270-275, public info pada 276-282.
- Page dan Policy dengan slug sama sama-sama memperoleh HTTP 201. Dua konten memakai `/info/:slug` yang sama, dan sitemap memuat URL dua kali. Endpoint publik mengambil LIMIT 1.
- Perlu namespace per jenis atau keunikan slug konten publik. Inventarisasi konflik existing sebelum menambah constraint, tanpa menghapus konten secara sembarangan.

### F08 / P2: Artwork bukan gambar utuh diterima
- Sumber: `engine/deep-routes.js:101-113`.
- JPEG yang hanya berisi dua byte penanda awal diterima HTTP 200 dan tersimpan.
- Perlu decode, batas pixel/dimensi dan re-encode backend. Ini bukti validasi gambar lemah, **bukan** klaim remote code execution atau kebocoran data.

## Kontrol tambahan yang lulus

1. API anonim 401, write tanpa CSRF 403, Viewer ditolak mengubah wallet, Support ditolak menulis settings.
2. UUID standar diterima; field Winning Chance dan Win Amount benar-benar tersimpan dan terbaca kembali; update game dengan versi lama ditolak 409.
3. Ronde per pemain terisolasi dan pagination satu record bekerja.
4. Wallet virtual tidak menggandakan credit akibat replay; audit gagal membatalkan credit; saldo tidak bisa negatif; transfer 25 menghasilkan debit/credit seimbang.
5. Endpoint ingest lama 410 dan bridge tanpa signature 401.
6. Signed bridge event diterima dengan desimal tepat, tanpa mengubah counter/wallet lama.
7. Viewer hanya mengubah display name sendiri; body berisi id/role tambahan tidak menaikkan role atau mengubah owner.
8. UUID wallet uppercase ditolak middleware 403 sebelum mutasi; saldo tetap.

Sesi CI disiapkan pada database disposable. Ini bukan pengujian enrollment MFA user produksi. Source crypto/MFA diperiksa dan tes existing tetap dijalankan. Kontrol yang lulus hanya berlaku pada skenario yang diuji, bukan jaminan tidak ada celah lain.

## Kesenjangan integrasi G01

Satu signed round disimpan di `gameops_bridge_rounds`; counter dashboard yang membaca `gameops_events` tetap **8 sebelum dan sesudah**. Event tidak hilang, tetapi sumber data belum direkonsiliasi. Ini pemisahan desain yang disengaja, bukan duplikasi atau kehilangan settlement.

Bridge menggunakan numeric(38,12), sedangkan event legacy memakai bilangan bulat. Integrasi tidak boleh diselesaikan dengan membulatkan nominal secara diam-diam. Perlu kontrak nominal, sumber kebenaran, deduplikasi dan aturan rekonsiliasi.

## Efek 19 System Settings dari source

- General: penyimpanan plus sebagian consumer UI; bonus/fee tidak diproses penuh.
- Logo/Favicon, System Configuration, SEO, Language: dominan simpan konfigurasi, belum semua menjadi efek runtime.
- Notification, KYC, Social Login, Extensions, GDPR: provider/executor/lifecycle belum terhubung.
- Templates dan Frontend: CRUD konten ada, renderer/slot consumer belum lengkap.
- Pages dan Policy: publikasi teks ada, dengan konflik URL F07.
- Cron: cleanup sesi kedaluwarsa lokal dan histori tersedia, bukan cron game eksternal.
- Maintenance: memblokir public info ketika enabled boolean true, bukan game eksternal.
- Custom CSS: draft sengaja tidak dieksekusi.
- Sitemap: endpoint ada, konfigurasi toggle belum menjadi consumer dan hostname hardcoded.
- Robots: rules tersimpan disajikan sebagai text/plain.

Tidak tepat melabeli semua modul aktif end-to-end. Bedakan tersimpan, diterapkan lokal, dan terhubung eksternal.

## Urutan perbaikan

Prioritaskan F01/F04/F05: route, transaksi audit dan SQL filtering. Lanjutkan typed settings/version conflict, actor tiket, canonical URL, decode artwork. Sesudahnya baru integrasi sumber identitas, notifikasi dan rekonsiliasi bridge.

Tambahkan tes server lengkap sebagai gerbang rilis. Reproducible dependency lockfile, timeout query, observabilitas job gagal, load test dan backup restore drill masih menjadi tindak lanjut, bukan hal yang sudah dibuktikan audit ini.

## Status dan reproduksi

PR #11 tetap draft; tidak ada merge atau deploy dari audit ini. Script menolak database non-localhost, mewajibkan gameops_ci, memeriksa hash source baseline, membuat schema acak, lalu menghapusnya. Evidence mencakup JSON temuan, daftar route, source snapshot, script reproduksi, log regresi dan log server fixture.

Laporan lengkap berbahasa Indonesia beserta JSON dan evidence ZIP diserahkan di percakapan sebagai `Playground_CP13_Backend_Audit.md`, `Playground_CP13_Backend_Audit.json`, dan `Playground_CP13_Backend_Audit_Evidence_Final.zip`.
