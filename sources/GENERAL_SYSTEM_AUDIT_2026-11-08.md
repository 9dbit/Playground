# Audit fungsi umum Playground — 8 November 2026

Cakupan pekerjaan ini: autentikasi, sesi, pembatasan akses, navigasi dashboard, dan audit aktivitas akun. Ini bukan sertifikasi seluruh fungsi bisnis. Alur taruhan, pendanaan koin, deposit/withdraw, dan pengaturan kemenangan tidak diimplementasikan atau diaktifkan dalam perubahan ini.

## Temuan dan perbaikan

| Fungsi | Temuan | Hasil |
|---|---|---|
| Batas percobaan login | Username dinormalisasi setelah kunci penghitung dibuat; variasi kapital/spasi memakai penghitung berbeda | Kunci mengikuti identitas ternormalisasi, jenis akun, tenant, dan IP. Maksimal 30 percobaan/15 menit per kombinasi; pembatas tambahan 180/15 menit per IP mencegah pergantian username menghindari pembatasan |
| Sesi workspace ditutup | Sesi lama tidak memeriksa status `closed` pada tenant | Permintaan sesi ditolak selama tenant berstatus closed; login baru juga ditolak |
| Logout | Sesi dihapus tanpa catatan logout tersendiri | Penghapusan sesi dan catatan `auth.logout` berada dalam satu transaksi; kegagalan audit membatalkan penghapusan |
| Sesi panel kedaluwarsa | Pesan error dapat meninggalkan formulir/data lama di layar | Data dialog dibersihkan; agen kembali ke login dengan kode agen dipertahankan; master kembali ke halaman login |
| Gangguan layanan saat membuka panel | Kesalahan jaringan/server dianggap sebagai kondisi belum login | Tampilan error dan tombol Coba lagi; kredensial tidak diminta ulang untuk gangguan server |
| Pembukaan master oleh akun tanpa izin | Pengambilan daftar agen gagal tanpa penanganan awal yang jelas | Pesan memerlukan master Owner dan tautan kembali; API daftar agen tidak diminta |
| Onboarding keamanan master | Halaman agen tidak menangani status setupRequired | Akun diarahkan ke Security Center |
| Tujuan setelah login master | Login selalu menuju dashboard awal | Tenant dan halaman asal dipertahankan. Tujuan dibatasi ke origin yang sama dan rute master `/agents` atau `/engine`; alamat eksternal ditolak |

Pembatas IP dapat memengaruhi kantor dengan banyak akun di balik satu alamat IP. Nilai 180 menghitung seluruh percobaan login dalam 15 menit, termasuk yang berhasil; tidak mengubah masa berlaku atau jumlah sesi aktif.

## Fungsi yang sudah tersedia dan batas bukti audit

| Fungsi | Bukti saat audit | Batas verifikasi |
|---|---|---|
| Login agen dan identitas tenant | Uji HTTP dengan database PostgreSQL WASM terisolasi | Tidak menggunakan akun pengguna sebenarnya |
| Pemisahan website/tenant | Sesi valid ditolak ketika konteks website berbeda | Tidak melakukan audit penetrasi seluruh endpoint |
| Hak akses master/agen | Pemeriksaan Owner backend sudah ada; UI menguji role dan menu terpilih | Tidak menyatakan seluruh peran di seluruh endpoint telah diuji ulang |
| Staff & IP | Kode memeriksa CIDR saat login/sesi; perubahan staff menaikkan auth_version, mencabut sesi, dan menjaga Owner aktif terakhir | Alur perubahan staff live tidak dijalankan |
| MFA | Kode memeriksa kode sekali pakai dan menahan staff yang belum enroll | Tidak mengubah authenticator atau recovery code pengguna |
| Pemulihan password | Kode memakai token hash, batas 15 menit, sekali pakai, verifikasi identitas, password/MFA untuk penerbitan, dan pencabutan sesi | Pengiriman email aktual belum diverifikasi pada audit ini; staff memakai jalur operator yang memverifikasi identitas |
| Audit aktivitas | Login sudah dicatat; logout ditambahkan dan diuji termasuk rollback | Tidak mengubah atau menghapus histori existing |
| Navigasi mobile/desktop | Uji browser 1440, 393, 320 px dengan aset aplikasi asli dan API fixture | Uji browser bukan sesi login production |

## Pengujian

- `tests/agency-auth-hardening.test.js`: identitas ternormalisasi, pemisahan tenant/jenis akun, pembatas IP, login/sesi, konteks website, tenant closed, logout/audit atomik.
- `tests/panel-account-ui.cjs`: desktop/mobile, retry gangguan server, pembersihan sesi, role Owner, setup keamanan, kembali ke halaman asal, penolakan return URL eksternal.
- `tests/panel-navigation-ui.cjs`: pemilihan agen, deep link/reload, menu sesuai peran, fallback rute, akses keyboard, dan overflow mobile.
- `npm test`: 69 lulus, 5 dilewati karena memerlukan native PostgreSQL, 0 gagal.

Guidebook yang dilampirkan berisi tautan ke Google Sites, bukan isi panduan. Audit ini menggunakan source code dan pengujian repo; tidak mengklaim kesesuaian menyeluruh dengan panduan eksternal tersebut.
