# Playground CP14: Remediasi seluruh P1 dan P2 CP13

Baseline: main 3e9dad5f010aa830ba4930d1d85cd793c25deb2c (v0.12.0).
Target: v0.14.0, PR #12, fix/cp14-backend-p1-p2-20261103.
Otorisasi: pemilik meminta semua P1 sampai semua P2 diselesaikan.

## Peta perbaikan

| Audit | Perbaikan source | Gerbang verifikasi |
|---|---|---|
| F01/P1 | Handler Game Log lama di server.js dihapus; hanya handler kanonis dengan search/filter/pagination. Duplikat System Information lama juga dibuang. | HTTP melalui server.js lengkap, bukan router terisolasi; tes deklarasi route tidak boleh duplikat. |
| F04/P1 | Data bisnis dan audit memakai koneksi/transaksi yang sama. Game/config/artwork, profil pemain, request, tiket/reply, notifikasi internal, subscriber, CMS, settings, profil admin dan revoke session diperbaiki. Wallet atomik dipertahankan. | Injeksi kegagalan audit pada 18 jalur harus menghasilkan rollback, tanpa perubahan bisnis maupun audit. |
| F05/P1 | Status dan pencarian pengguna diterapkan dalam SQL sebelum LIMIT, dengan count dan pagination snapshot konsisten. Urutan last_seen/id stabil. UI memiliki pencarian dan halaman. | Pengguna blocked lama tetap ditemukan setelah 205 pengguna aktif baru, serta paging tanpa duplikasi. |
| F02/P2 | Schema tipe/rentang/allowlist untuk 15 form settings; 4 modul konten hanya lewat CMS versioned. Input tidak valid ditolak 400. | Uji seluruh form, tipe salah, nilai negatif, persentase, timezone, warna, URL dan field tambahan. |
| F03/P2 | expected_version wajib (0 untuk record baru), version check atomik dan 409 jika kedaluwarsa. UI menjaga isian yang belum tersimpan, menampilkan error dan reload eksplisit. Setiap revisi diarsipkan. | Dua tab browser nyata dan dua request bersamaan: satu berhasil, satu 409; request tanpa versi 428. |
| F06/P2 | Author reply dari identitas admin terautentikasi; field author dari body tidak dipercaya. Audit satu transaksi. | Support benar-benar tampil sebagai Support; pesan historis tidak ditebak atau ditulis ulang. |
| F07/P2 | URL kanonis /info/page/:slug dan /info/policy/:slug. Legacy unik redirect 308, legacy ambigu 300 berisi pilihan. Sitemap memakai URL kanonis dan origin konfigurasi. | Page/Policy dengan slug sama tetap utuh dan tampil berbeda; sitemap tidak duplikat; tidak ada penghapusan konten. |
| F08/P2 | Decode pixel penuh, cek format/dimensi/pixel/animasi, re-encode WebP tanpa metadata sebelum menyimpan dan audit. Dua decoder maksimum serentak. | JPEG dua byte, data terpotong, format palsu, dimensi/pixel berlebihan ditolak. PNG/JPEG/WebP valid dinormalisasi. |

## Kontrak API dan kompatibilitas

PUT /api/admin/settings/:key sekarang membutuhkan {value, expected_version}. Form editor utama sudah diperbarui; editor lama /engine-v1 mengarahkan ke editor versioned. Klien API lama tanpa versi akan menerima 428, bukan menimpa data secara diam-diam.

Nilai lama yang invalid atau memiliki field historis tidak dihapus saat startup. GET owner menampilkan status validasi. Ketika owner menyimpan revisi yang valid, snapshot lama diarsipkan dalam gameops_settings_versions. Migrasi hanya menambah tabel/index; tidak menghapus akun, konten atau saldo.

URL /info/:slug lama tetap tersedia. Jika ada dua konten, server tidak lagi memilih LIMIT 1 secara arbitrer; kedua link kanonis ditampilkan. Konten tidak dipindah atau dihapus.

Artwork baru maksimum 500 KB input, 4096 px per sisi dan 16 juta pixel, satu frame. Hasil dinormalisasi maksimum 1600 px dan 500 KB. Nilai lama tidak dihapus secara otomatis.

## Batas keamanan dan integrasi

MFA, password owner, RBAC, CSRF, signed bridge keys, hasil game dan ledger tidak direset. Tidak ada game produksi, saldo eksternal atau settlement uang asli yang diaktifkan. Kesenjangan integrasi G01 dan full functional parity Xaxino tetap terpisah dari delapan defect ini.

## Pengujian

- tests/p1p2-full-server.test.js menjalankan server.js, middleware asli, PostgreSQL 18, fault injection, concurrency dan readback.
- tests/p1p2-live-browser.cjs memakai browser dengan API nyata ke server fixture, tanpa mocked responses.
- Fixture menolak database non-localhost/non-gameops_ci, membuat schema acak dan menghapusnya setelah tes.
- Seluruh regresi yang ada tetap dijalankan. package-lock.json memastikan dependency reproducible.
- Source staging ditransfer dengan hash sebelum/sesudah yang diverifikasi; helper transport dan workflow berizin tulis dihapus sebelum merge. Workflow rilis yang tersisa hanya contents: read.

## Status penerimaan

Dokumen source ini menjelaskan implementasi, bukan bukti bahwa deployment sudah selesai. Angka kelulusan final, SHA yang diuji, hasil browser, status Railway dan smoke test dicatat pada komentar rilis PR #12 dan laporan akhir yang dilampirkan setelah pengujian selesai. Jangan merge sebelum semua gerbang rilis lulus.
