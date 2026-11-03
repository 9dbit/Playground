# Playground Agency — publikasi dan sandbox, 3 November 2026

Branch `feat/agent-platform-20261103` sudah dipublikasikan dan [PR #18](https://github.com/9dbit/Playground/pull/18) berstatus **draft**. Sandbox terpisah sudah online dan lolos pengujian HTTP serta browser. Rilis ini menyelesaikan fondasi operasional dalam mode simulasi; integrasi native game, gateway nyata dan Chatvice privat masih memiliki pekerjaan tersisa.

## Deployment yang diverifikasi

| Item | Nilai |
|---|---|
| Repository | `9dbit/Playground` |
| Commit aplikasi yang diuji dan dideploy | `76fa31b7ac7fea70517886db96e85af9aef69e20` |
| Versi aplikasi | `0.17.0` |
| Service Railway | `playground-agent-sandbox` |
| Service ID | `570d97f6-41da-4f37-9d93-879137c06872` |
| Deployment ID | `4f84640b-39e6-4e0b-bb27-9d20a4cc30ad` |
| Status deployment | `SUCCESS`, 3 November 2026 10:51:05 UTC / 17:51:05 WIB |
| Database | PostgreSQL 18, schema `agency_sandbox_v1` |
| Runtime | Node.js 22, region `sfo` |
| Health | HTTPS `/health`: HTTP 200, `db: connected` |

Service ini menggunakan project dan environment Railway yang sudah ada, tetapi memiliki proses aplikasi, kredensial dan skema tabel sendiri. Environment Railway bernama `production`; nama tersebut tidak mengubah mode aplikasi sandbox. PostgreSQL dipakai bersama sebagai infrastruktur, sehingga ini bukan isolasi server/database fisik atau database role terpisah. Aplikasi sandbox memakai schema tervalidasi tanpa fallback ke `public`.

Deployment `playground-admin` tetap `893318cf-f996-4cd7-b4ca-b8a4ab701791`; service tersebut tidak dideploy ulang. Keempat service dalam environment berstatus online tanpa issue saat pemeriksaan. Source sandbox dipin ke commit aplikasi di atas. Commit dokumentasi/bukti berikutnya tidak mengubah build yang berjalan.

## Akses

- [Master Playground](https://playground-agent-sandbox-production.up.railway.app/agents)
- [Login staff agen](https://playground-agent-sandbox-production.up.railway.app/agency)
- [Website demo shared](https://playground-agent-sandbox-production.up.railway.app/site/demo-shared)
- [Website demo split](https://playground-agent-sandbox-production.up.railway.app/site/demo-split)
- [Railway service — buka tab Variables](https://railway.com/project/e82d39c1-bd46-45b1-ba9d-bdd5bc2ee5ad/service/570d97f6-41da-4f37-9d93-879137c06872?environmentId=39bb2be6-ff8e-4957-b82f-c371ad9d7f11)

| Login | Tenant/slug | Username | Password tersimpan di Variables |
|---|---|---|---|
| Master | — | `admin` | `ADMIN_PASSWORD` |
| Owner shared | `demo-shared` | `owner` | `DEMO_SHARED_OWNER_PASSWORD` |
| Owner split | `demo-split` | `owner` | `DEMO_SPLIT_OWNER_PASSWORD` |

Password tidak disimpan di GitHub. Akun master dan kedua owner siap untuk enrollment authenticator pribadi. Login master mengarahkan ke Security Center sampai enrollment selesai. Simpan recovery code master secara privat. Staff `qa_supervisor` sudah dinonaktifkan dan sesi pengujiannya ditolak. Authenticator sementara master telah direset dan password akhir diverifikasi melalui login baru, lalu sesi pemeriksaan ditutup.

Password akun disimpan dalam database. Nilai environment hanya dipakai untuk bootstrap master saat tabel kosong; mengubah Variables saja tidak mereset password akun. Variabel `DEMO_*` menyediakan kredensial awal untuk handoff, bukan mekanisme autentikasi aplikasi. Jika password diganti melalui aplikasi, perbarui catatan akses privat tersebut.

## Hasil verifikasi

| Lapisan | Hasil |
|---|---|
| Regresi native PostgreSQL 18 | 82 lulus, 0 gagal, 0 dilewati |
| Agency HTTP/system + Chromium di CI | 25 lulus, 0 gagal |
| Seluruh workflow pada commit aplikasi | 5 sukses |
| Sandbox terpasang | Deposit otomatis/manual, saldo, isolasi tenant, withdraw, funding, invoice, CSV dan tiket lulus |
| Browser pada URL sandbox | Master, agen, mobile dan storefront lulus; tanpa page error pada dashboard master yang dipantau |

[Run CI PostgreSQL/Chromium](https://github.com/9dbit/Playground/actions/runs/41622141420). Bukti terstruktur: [CI](evidence/agency-ci-2026-11-03.json), [HTTP, akun dan handoff](evidence/agency-deployed-smoke-2026-11-03.json), [browser](evidence/agency-deployed-ui-2026-11-03.json).

Screenshot data sintetis: [master](evidence/agency-deployed-master.png), [mobile](evidence/agency-deployed-mobile.png), [agen](evidence/agency-deployed-agent.png), [website](evidence/agency-deployed-storefront.png).

Alur shared menjual 10.000 koin melalui deposit otomatis, membayar withdraw 1.000 setelah approval supervisor dan 500 secara otomatis ke beneficiary yang telah diverifikasi. Saldo player menjadi 8.500 dan invoice net 20% menjadi 1.700. Retry deposit dan closing tidak membuat kredit/invoice ganda.

Alur split menjual 5.000 koin melalui deposit manual yang diverifikasi staff agen. Withdraw 100 tertahan meski akun deposit memiliki saldo, lalu selesai setelah akun disbursement diisi. Saldo player menjadi 4.900 dan invoice gross 20% tetap 1.000. Closing November dilakukan lebih awal hanya untuk simulasi, sehingga invoice contoh sudah terkunci.

## Mencoba alur

1. Selesaikan login dan enrollment authenticator master atau owner agen. Master dapat membuat agen baru untuk pengujian dengan buku yang masih kosong.
2. Ajukan stok koin di dashboard agen, lalu setujui alokasinya dari master. Dua agen demo sudah diberi stok awal 100.000.
3. Daftar akun player sendiri dari website demo. Pilih deposit QRIS/VA untuk melihat worker simulasi mengonfirmasi pembayaran dan settlement, atau transfer manual untuk menguji approval staff agen.
4. Coba withdraw: beneficiary baru membutuhkan review supervisor dengan password dan TOTP. Transaksi berikutnya yang memenuhi kebijakan dapat diproses otomatis. Model split memerlukan saldo akun withdraw tersendiri.
5. Periksa transaksi, saldo, audit, laporan dan invoice. Gunakan agen baru untuk mencoba closing dari awal; invoice contoh November milik demo sudah final.

## Pekerjaan tersisa sebelum penggunaan live

- Native UNO, Mahjong dan Skygate belum berpindah ke otoritas wallet pusat; ketiganya tetap `registered` dan tombol main tidak aktif. Pengujian protokol memakai adapter sintetis.
- Tidak ada gateway/bank yang dihubungi. `AGENCY_SIMULATION_WORKER=true`; QRIS/VA dan payout adalah simulasi. Provider nyata, webhook, rekonsiliasi dan uji sandbox provider masih diperlukan.
- Widget Chatvice belum diaktifkan karena merchant/domain serta identitas privat belum diverifikasi. Panduan operasional dan tiket lokal tetap dapat digunakan.
- WebAuthn/fingerprint belum diimplementasikan sebagai faktor approval; step-up saat ini memakai password dan TOTP. Hardening database role/RLS, pemulihan akun, uji restore, beban dan pilot live tetap mengikuti [rencana implementasi](PLAYGROUND_AG_IMPLEMENTATION_STATUS_2026-11-03.md).

Untuk menghentikan sandbox, hentikan worker/service baru dan simpan ledger serta bukti. Jangan menimpa jurnal yang sudah diposting dengan snapshot saldo lama. PR tetap draft dan belum digabung ke `main`.
