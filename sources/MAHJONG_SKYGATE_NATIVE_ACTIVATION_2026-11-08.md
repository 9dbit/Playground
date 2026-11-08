# Aktivasi native Mahjong dan Skygate — 8 November 2026

## Hasil implementasi

Mahjong Wild dan Skygate 5000 sekarang mempunyai runtime server native yang meluncur melalui token Playground dan menggunakan ledger pusat agen/player. Tidak ada saldo demo, reset wallet lokal atau payout yang dipercaya dari browser pada mode ini. UI/art/math asli dipertahankan; editor Studio dan service game semula tetap terpisah.

| Game | Implementasi | Source | Draft PR | Sandbox |
|---|---|---|---|---|
| Mahjong Wild | FastAPI, engine Python asli, konfigurasi baseline + engine hash per tiket | `a19db2018013ba54fa4425b19bc9dcf0f7f2cdc3` | https://github.com/9dbit/Mahjong-legend/pull/16 | https://mahjong-agency-sandbox-production.up.railway.app |
| Skygate 5000 | Node 24, engine asli server-side, crypto RNG dan config hash per ronde | `1af2c6de0ff6384602e14cfb45b41c3d6446104d` | https://github.com/9dbit/Skygate/pull/25 | https://skygate-agency-sandbox-production.up.railway.app/play/ |

Buka game melalui tombol Play website 64COR agar token player/agen diterbitkan. Link game langsung tanpa sesi menolak akses saldo. Key HMAC terpisah per game/environment dan tidak diberikan ke browser. Kunci native UNO dipertahankan.

## Presisi dan transaksi

- `coin_scale` agen tidak dimigrasi; seluruh saldo existing tetap dalam satuan semula.
- Stake dan biaya mesti tepat pada presisi agen. Mahjong skala 0 hanya menampilkan bet 1/2/5/10; Skygate menolak biaya pecahan yang tidak terwakili, termasuk booster, dan pemilih total melangkah ke nominal yang valid.
- Payout dihitung sesudah seluruh cascade/free spins/bonus, lalu half-up satu kali ke presisi agen. Liability reserve dibulatkan ke atas. Contoh skala 0: 0.5 → 1 dan 0.49 → 0. Kebijakan ada pada informasi game; angka payout final pada UI mengikuti wallet.
- Paytable, bobot, multiplier dan cap asli tidak diubah. Pembulatan tetap dapat memengaruhi return efektif; native sandbox tidak mengesahkan ekonomi live.
- Intent, request ID, hasil, stake, payout dan sesi canonical disimpan SQLite FULL/WAL sebelum reserve. Retry dan worker 30 detik menggunakan hasil yang sama. Settlement server terjadi sebelum animasi. Tidak ada refund/reroll lokal setelah timeout.
- Satu process/replica per game, volume persistent `/data`, deployment overlap 0. Tidak aman menaikkan replica SQLite ini tanpa migrasi koordinasi/storage. Pending round tidak boleh dihapus sebagai cara memperbaiki koneksi.

## Bukti validasi

- Mahjong: 34 Python native/math/invariant tests pass.
- Skygate: 118 Node tests pass termasuk fault injection, presisi integer dan actual crypto-RNG engine.
- Playground: 40 skenario integrasi pass, termasuk regresi UNO. Backend unit: 60 pass, 5 skip khusus native PostgreSQL.
- UAT memakai frontend 64COR, tombol Play, renderer game asli pada Chromium 393×852, wallet Playground dan database PGlite terisolasi. Bridge hostname HTTPS hanya meneruskan request ke server game lokal, termasuk Origin; tidak membuat respons wallet atau hasil game palsu.
- Mahjong: spin → restart process → retry tiket yang sama → satu ronde settled/satu journal → kembali ke 64COR dengan saldo sama.
- Skygate: spin → restart → retry sama → BUY SPIN → Bonus Booster; tiga ronde settled, masing-masing satu settlement journal, saldo kembali ke 64COR sama.
- Kedua tenant ledger mismatch 0. Fault tests mensimulasikan respons hilang sesudah reserve dan sesudah settlement, lalu membuka ulang database; hasil tidak dihitung ulang dan saldo tidak dibayar dua kali.
- Release admin sekarang menolak payload slug yang berbeda dari identitas game dalam katalog, meski beberapa signing key telah aktif.
- Bukti ringkas tanpa identitas akun: `sources/evidence/mahjong-skygate-native-2026-11-08.json`.

## Aktivasi dan batas

Dua service baru mempunyai volume terpisah. Playground sandbox memakai manifest `AGENCY_SANDBOX_RELEASES` dengan SHA exact, HTTPS launch URL dan bukti UAT. Manifest hanya dapat diterapkan pada schema `agency_sandbox_*`, tenant sandbox dan signing key sesuai game. Pilihan/entitlement agen tetap dihormati; deployment tidak menambah koin player atau memindahkan saldo demo.

Mode live ditolak oleh runtime. Publikasi Studio lintas-service, migrasi wallet guest lama, sertifikasi RTP/ekonomi live dan pengujian beban native PostgreSQL bukan hasil yang diklaim dalam perubahan ini. Provider pembayaran/email/SMS/KYC/OAuth tetap mengikuti handoff tersendiri.

## Deployment terverifikasi

Ketiga deployment berikut telah diamati terminal **SUCCESS**:

| Service | Deployment | Source |
|---|---|---|
| mahjong-agency-sandbox | `63f6fa25-051d-4cab-82fd-294a875203f7` | `a19db2018013ba54fa4425b19bc9dcf0f7f2cdc3` |
| skygate-agency-sandbox | `799bbf1e-1412-4ced-a5a0-ebb275454495` | `1af2c6de0ff6384602e14cfb45b41c3d6446104d` |
| playground-agent-sandbox | `aa5374de-82f6-4c66-9609-25b77b5335ea` | `54a9174c0b7a4ad45838450a5e3c5a1017190359` |

Health publik kedua native runtime: HTTP 200, mode sandbox, wallet Playground, database connected dan exact source commit cocok. Manifest 64COR deployed menampilkan Mahjong, Skygate dan UNO **Active/publishable**.

Smoke test deployed memakai satu akun sintetis zero-coin yang identitasnya tidak dipublikasikan: registrasi melalui storefront → token launch 64COR → redeem native → state wallet pusat berhasil untuk Mahjong dan Skygate. Saldo/reserved 0, presisi agen tetap 0, cookie Secure/HttpOnly/SameSite Strict. State tanpa sesi menolak 401; reset lokal Mahjong menolak 403 dan Skygate tidak menyediakan endpoint reset (404). Launch/redeem/status UNO juga diuji kembali untuk membuktikan kunci lama tetap berfungsi.

Tidak ada deposit, withdraw atau paid round dalam smoke test deployed; paid-round browser UAT dijalankan pada database terisolasi. Bukti deidentified: `sources/evidence/mahjong-skygate-deployed-2026-11-08.json`. Service Playground master produksi semula, main branches dan saldo existing tidak diubah. Commit dokumentasi sesudahnya tidak memerlukan deployment ulang kode.


## Navigasi kembali dan sesi (8 November 2026)

Tombol kembali berbentuk lingkaran putih dengan panah ungu tersedia pada kedua game native, beserta tautan pada menu dan pesan pemulihan. Tujuan diambil dari domain utama agen yang sudah diverifikasi; tanpa domain itu, 64COR memakai storefront resminya dan agen lain memakai route tenant di public origin Playground. Return URL dari payload player, referrer atau fragment tidak dipercaya.

Redeem dan signed status pusat mengirim navigation dan expiry dua jam yang sebenarnya. Endpoint context native hanya memberi metadata dari cookie sesi, sehingga tautan kembali tetap tersedia jika pembacaan wallet pusat gagal. Sesi kedaluwarsa menampilkan petunjuk kembali dan membuka ulang game; spin baru tetap ditolak server. Ronde yang sudah diterima tetap diselesaikan, bukan dihapus atau direfund saat pemain keluar. Gangguan koneksi memberi pilihan mencoba lagi untuk memulihkan state.

UAT mobile memakai tombol kembali asli sambil menahan respons spin yang sudah diproses server. Setelah kembali ke akun 64COR, saldo cocok, semua ronde settled, masing-masing satu settlement journal. Mahjong: dua ronde; Skygate: empat ronde termasuk Buy Spin dan Bonus Booster. UAT juga memaksa expiry pada database terisolasi dan memeriksa pesan serta tujuan kembali. Seluruh 40 skenario integrasi lulus; unit backend 62 lulus/5 skip, Mahjong 34 lulus, Skygate 118 lulus. Tidak ada transaksi bank atau paid spin pada layanan deployed.

Bukti: `sources/evidence/mahjong-skygate-native-2026-11-08.json`. Ini melengkapi integrasi sandbox; tidak mengaktifkan ekonomi live atau publikasi Studio lintas-service.
