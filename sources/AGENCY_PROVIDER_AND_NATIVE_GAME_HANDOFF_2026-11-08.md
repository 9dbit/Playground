# Provider dan game native — batas aktivasi 8 November 2026

Dokumen ini membedakan kode yang sudah bisa dijalankan dari dependensi integrasi yang belum tersedia. Tidak ada perubahan persentase kemenangan atau saldo pada game deployed.

## Provider di service Playground

Gateway pembayaran, SMS, KYC dan OAuth **belum dihubungkan**. Jangan mengaktifkan UI atau label verified/paid dari toggle konfigurasi. Agent tidak memilih payment gateway. Akun merchant, pemetaan deposit/disbursement SHARED/SPLIT dan secret tetap di bawah pengelolaan Playground.

Untuk pembayaran, diperlukan nama provider dan akun merchant yang mendukung skema multi-agen; spesifikasi reference/account ID, webhook autentik, idempotency, lookup status, reversal dan settlement statement. Implementasi simulator tetap dibatasi sandbox. Memiliki webhook payload saja tidak membuktikan settlement rekening. Tidak ada transfer nyata pada QA.

Email sudah mempunyai adapter opsional **Resend** dan outbox durable. Default tetap nonaktif. Variabel service backend:

- `AGENCY_EMAIL_PROVIDER=resend`
- `AGENCY_EMAIL_FROM`: alamat dari domain pengirim yang diverifikasi di provider
- `AGENCY_RESEND_API_KEY`: secret pada Railway, jangan ditaruh di CMS atau repository
- `PUBLIC_SITE_URL`: URL HTTPS backend yang melayani `/agency-email` dan `/agency-recovery`

Worker berjalan setiap 5 detik, memakai lease DB, retry maksimal 5 percobaan, key provider stabil per job, payload terenkripsi dan TTL 15 menit. Retry berhenti saat link kedaluwarsa. Status `accepted` berarti API provider menerima pesan, **bukan bukti delivered**; webhook delivery/bounce belum diimplementasikan. Isi email dihapus dari outbox setelah accepted/failed/expired. Hanya player dengan email yang sudah diverifikasi bisa memakai pemulihan email otomatis. Perubahan alamat membatalkan token dan antrean lama serta menghapus status verifikasi. Staff memakai recovery operator dengan password + TOTP; MFA tidak dihapus.

Tidak ada email dikirim keluar pada pengujian. QA memakai mock adapter dan database terisolasi. Provider production/domain deliverability tetap perlu UAT setelah kredensial tersedia.

Referensi adapter: [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email), [Idempotency Keys](https://resend.com/blog/engineering-idempotency-keys). Untuk calon gateway (belum pilihan final): [Xendit webhook security](https://docs.xendit.co/docs/handling-webhooks).

## Transport wallet game yang tersedia

- `adapters/agency-wallet.cjs`: Node.
- `adapters/agency_wallet.py`: Python/FastAPI/Django.
- Signed `redeem`, `reserve`, `settle`, `void`, dan `status` pada `/api/v4/agency-game/*`.
- `redeem` dengan `request_id` yang sama bisa diulang setelah respons hilang dan mengembalikan session yang sama; request ID berbeda ditolak. Replay lama tanpa request ID tetap ditolak.
- `status` dibatasi tenant, game, environment, dan session; menyediakan saldo pusat serta ronde terkait. Bisa dipakai untuk rekonsiliasi sesi kedaluwarsa. Tidak memberi izin memulai ronde baru.
- Simpan request ID dan outcome di DB native sebelum request jaringan. Jika timeout: status tidak pasti; jangan mengganti round reference, menambahkan saldo lokal, atau menghitung ulang outcome.
- Secret hanya pada server native. Frontend menerima token launch sekali pakai lewat fragment, lalu menukarkannya ke server native. Jangan memanggil HMAC endpoint dari browser.

**Status lanjutan 8 November:** UNO Orbit sudah menggunakan transport ini pada jalur gameplay native, dengan outcome/phase durable, retry dan abandonment settlement. Lihat `UNO_NATIVE_WALLET_ACTIVATION_2026-11-08.md`. Mahjong dan Skygate belum terpasang dan tetap Maintenance; adapter transport saja tidak cukup untuk mengaktifkannya.

## Temuan source native dan keputusan yang masih diperlukan

| Game / source | Temuan yang dibaca | Pekerjaan sebelum publishable |
|---|---|---|
| UNO LUCK `9dbit/uno-luck`, `app/orbit.py`, `app/spin.py` | FastAPI + SQLite; tiga kartu dipilih server-side; debit/payout memakai `accounts.balance` dan ledger lokal; bonus/refill lokal. `WIN_PERCENT=80`, payout tier bersifat koin virtual. | Implementasi sandbox selesai: wallet pusat, SQLite durable, retry lintas restart/sesi, hadiah/refill lokal ditolak, abandonment 15 menit. coin_scale harus 0. Ekonomi payout belum layak live; math tidak diubah. |
| Mahjong `9dbit/Mahjong-legend`, `game_studio/game.py` | Django, `PlayerSession`, ticket/idempotency/ledger lokal, Decimal hingga 12 digit. | Mapping precision ke `coin_scale`, durable reservation/outcome, cutover identitas player, crash/retry/bonus-round tests. |
| Skygate `9dbit/Skygate`, `play/game.js`, `studio/math/engine.js` | Frontend permainan dan engine deterministik berbasis seed; server saat ini melayani aset/studio, bukan otoritas wallet ronde. | Runtime outcome server-side dengan RNG yang sesuai, persistence ronde, integrasi reserve/settle dan validasi bahwa client tidak dapat mengirim payout yang dipercaya. |

Untuk UNO source yang diinspeksi, expected multiplier kemenangan = `0.0001×200 + 0.0009×80 + 0.004×30 + 0.03×10 + 0.965×2 = 2.442`; dengan peluang match 80%, expected gross return sebelum cap saldo = **1.9536× stake (195.36%)**. Ini perhitungan dari konstanta source virtual, bukan pengukuran game deployed. Mengaktifkannya sebagai ekonomi agen tanpa keputusan eksplisit berpotensi menghabiskan risk pool. Tidak mengubah odds untuk “memperbaiki” hal ini secara sepihak.

Prasyarat native release: exact code commit dan versi math, kontrak satuan saldo, bukti settlement dengan browser game asli, crash recovery pada setiap boundary, signature/replay negative tests, reconciled round IDs dan risk pool. Gate `publishable` tetap memerlukan bukti tersebut. Heartbeat dan synthetic signed-round test tidak menggantikannya.
