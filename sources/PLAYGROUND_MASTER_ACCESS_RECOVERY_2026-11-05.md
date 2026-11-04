# Pemulihan akses master Playground — 5 November 2026

Versi aplikasi: **0.17.1**. Target: service `playground-agent-sandbox`, branch `feat/agent-platform-20261103`, PR #18. Perbaikan ini menambahkan perubahan username/password master melalui Railway dan petunjuk pemulihan pada halaman login.

## Penyebab kegagalan login sebelumnya

Pada versi 0.17.0, `ADMIN_USERNAME` dan `ADMIN_PASSWORD` hanya dipakai ketika tabel akun masih kosong. Perubahan Variables berhasil dideploy pada 5 November 2026 pukul 02:12 WIB, tetapi password akun yang sudah ada tetap memakai hash lama. Log menunjukkan HTTP 401 saat login. Mengubah konfigurasi tidak melakukan reset database pada versi tersebut.

## Cara menggunakan

1. Buka [service Railway playground-agent-sandbox](https://railway.com/project/e82d39c1-bd46-45b1-ba9d-bdd5bc2ee5ad/service/570d97f6-41da-4f37-9d93-879137c06872?environmentId=39bb2be6-ff8e-4957-b82f-c371ad9d7f11), lalu tab **Variables**.
2. Pastikan `ADMIN_CREDENTIALS_SYNC=true`. Flag ini mengaktifkan pengelolaan kredensial master dari konfigurasi service.
3. Isi `ADMIN_USERNAME` dan `ADMIN_PASSWORD` sesuai akses yang diinginkan. Username harus 3–64 karakter, diawali huruf/angka, memakai huruf kecil, angka, titik, garis bawah atau minus. Password harus 15–128 karakter. Jangan menambahkan tanda kutip sebagai pembungkus nilai.
4. Simpan perubahan dan **Deploy**. Tunggu status **SUCCESS**.
5. Buka [login master](https://playground-agent-sandbox-production.up.railway.app/login), gunakan nilai terbaru. Authenticator yang sudah terdaftar tetap diperlukan. Jika belum terdaftar, lanjutkan enrollment di Security Center.

Untuk mengganti password saat masih bisa login, gunakan **Security Center → Change password**. Restart/deploy dengan Variables yang tidak berubah tidak menimpa perubahan tersebut. Jika lupa password dan ingin memakai ulang nilai Variables yang sama, ubah `ADMIN_CREDENTIALS_REVISION` ke penanda baru, misalnya `recovery-2026-11-05-2`, lalu deploy. Alternatifnya, pilih password baru di `ADMIN_PASSWORD`.

Hanya akun master awal yang dikelola melalui Variables ini. Akun staff master lain, owner/staff agen dan player tetap memakai pengelolaan akun masing-masing. Halaman login menyediakan tombol “Lupa password atau username?”; petunjuk Railway hanya ditampilkan saat mode tersebut aktif. Ini bukan pemulihan melalui email.

## Perilaku dan batas

- Pengaitan akun memakai ID master awal dari audit bootstrap, lalu ID itu disimpan. Perubahan username memperbarui akun yang sama, tanpa membuat akun kedua.
- Perubahan username/password/revision diproses sekali dalam transaksi dengan lock yang sama seperti bootstrap. Fingerprint konfigurasi memakai HMAC; password tetap disimpan sebagai hash scrypt.
- Sesi master lama dicabut dan limit percobaan berdasarkan username lama/baru dibersihkan. Limit IP tetap berlaku. Data agen, saldo, invoice dan akun lain tidak diubah.
- Authenticator aktif dan recovery code tidak dihapus. Untuk lupa authenticator, gunakan recovery code; reset password bukan reset MFA.
- Username bentrok, password tidak valid, akun awal hilang/non-owner/dinonaktifkan, atau audit bootstrap ambigu menyebabkan deployment gagal sebelum perubahan kredensial tersimpan. Jangan menghapus tabel akun untuk memperbaiki konflik.
- Saat pertama kali `ADMIN_CREDENTIALS_SYNC=true` digunakan, kredensial Variables saat itu diterapkan ke akun master awal yang sudah ada. Ini menyelesaikan kasus password baru yang sebelumnya sudah dideploy tetapi belum tersimpan pada akun.
- `ADMIN_CREDENTIALS_SYNC=false` mempertahankan perilaku bootstrap saja. Menonaktifkannya tidak membatalkan password yang sudah diterapkan.
- Rollback build/config perlu memperhatikan nilai Variables: konfigurasi berbeda dapat menerapkan kembali kredensial tersebut. Jangan merotasi `SESSION_SECRET` untuk mereset password, karena secret itu juga melindungi data authenticator.

## Bukti verifikasi

`tests/security-runtime.test.js` memakai HTTP login nyata serta database disposable: PostgreSQL native di CI, PGlite untuk pengujian lokal. Cakupan: pemulihan akun existing, rename, startup bersamaan, pencabutan sesi, MFA/recovery code tetap berlaku, deploy berulang, password dari panel tetap tersimpan, revision, konflik username, input tidak valid, akun disabled/non-owner, audit bootstrap ambigu, dan data akun lain tetap utuh.

`tests/security-ui.cjs` memeriksa petunjuk pemulihan saat mode aktif/nonaktif, tampilan 390px dan alur login/MFA existing. Regresi GameOps dan simulasi agency juga dijalankan. Hasil CI dan status deployment dicatat pada [PR #18](https://github.com/9dbit/Playground/pull/18) setelah tersedia; dokumen ini tidak menganggap deploy sukses hanya karena kode telah dipush.

Log startup `[security-runtime-credentials] applied_verified` berarti transaksi sudah tersimpan dan hash password database berhasil diverifikasi terhadap konfigurasi runtime. `unchanged` berarti konfigurasi telah diterapkan sebelumnya. Log tidak memuat username, password atau fingerprint. Verifikasi ini tidak sama dengan menguji login interaktif menggunakan password milik pengguna.
