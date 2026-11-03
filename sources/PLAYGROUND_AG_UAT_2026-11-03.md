# Playground Agency — hasil simulasi 3 November 2026

Hasil: **25 lulus, 0 gagal**. Lingkungan: PostgreSQL WASM (PGlite), Express lengkap, HTTP nyata, dan Chromium headless. Data agen/pemain seluruhnya sintetis. Tidak ada pembayaran atau disbursement eksternal.

Regresi lokal: 48 lulus, 5 dilewati karena PostgreSQL native belum tersedia, 0 gagal.

Setelah publikasi, [CI PostgreSQL 18 + Chromium](https://github.com/9dbit/Playground/actions/runs/41622141420) pada commit `76fa31b7ac7fea70517886db96e85af9aef69e20` menghasilkan **82 tes regresi lulus, 0 gagal, 0 dilewati**, serta **25 skenario agency lulus, 0 gagal**. Lima workflow berakhir sukses. [Bukti CI](evidence/agency-ci-2026-11-03.json).

| ID | Pemeriksaan | Hasil |
|---|---|---|
| T01 | Two tenant reads, guessed IDs and global APIs are isolated | PASS |
| T02 | Permission and CSRF are enforced server-side | PASS |
| T03 | Paid deposit consumes stock and credits once, duplicate/conflict detected | PASS |
| T04 | Confirmed deposit is pending cash until provider settlement | PASS |
| T05 | Agent admin approves manual bank deposit; bank reference cannot be reused | PASS |
| T06 | Automatic transaction cannot be marked paid merely by supervisor | PASS |
| T07 | Late payment without stock remains received/credit pending | PASS |
| T08 | New beneficiary requires supervisor; bound approval is single use | PASS |
| T09 | Payout timeout is held; retry paid is exactly once, reversal once | PASS |
| T10 | Threshold < 1m auto, =1m manual and split cash cannot fund payout | PASS |
| T11 | Game signed launch, reserve, settlement and replay are tenant bound | PASS |
| T12 | Concurrent wallet spending cannot exceed available balance | PASS |
| T13 | Gross/net examples and cross-month historical-rate credits reconcile | PASS |
| T14 | Website content has CAS, escaped rendering, publication and rollback | PASS |
| T15 | Staff role/session revoke and CIDR restriction enforced | PASS |
| T16 | Immutable balanced journals and independent cash/coin books | PASS |
| T17 | Monthly statement locks and invoice cannot be duplicated | PASS |
| T18 | Full server health and admin pages remain available | PASS |
| T19 | Finalized journals reject appended entries and a failed transaction rolls back every book | PASS |
| T20 | Restricted players retain history and reviewed withdrawal access but cannot deposit or play | PASS |
| T21 | Signed game nonce replay, forged signatures and release slug substitution are rejected | PASS |
| T22 | Canonical and verified domain routing cannot cross tenant boundaries | PASS |
| T23 | Operational guidance, private export and Chatvice merchant scope follow permissions | PASS |
| T24 | Automatic simulator recovers received deposits, settles cash and completes queued payouts without repeat posting | PASS |
| BROWSER | Desktop/mobile dashboard and player website use the actual backend | PASS |

Bukti terstruktur: [agency-system-2026-11-03.json](evidence/agency-system-2026-11-03.json).

Tampilan dashboard: [desktop](evidence/agency-desktop.png), [mobile](evidence/agency-mobile.png).

Rincian implementasi dan pekerjaan tersisa: [checkpoint](PLAYGROUND_AG_IMPLEMENTATION_STATUS_2026-11-03.md).

## Verifikasi sandbox yang sudah dideploy

[Sandbox Railway](https://playground-agent-sandbox-production.up.railway.app/agents) menggunakan PostgreSQL native dan skema `agency_sandbox_v1`. Pemeriksaan HTTP mencakup dua agen, MFA staff, deposit otomatis/manual, retry tanpa saldo ganda, penolakan akses lintas agen, withdraw dengan approval supervisor lalu auto-approve, top-up disbursement, invoice gross/net dan ekspor sesuai tenant. Pemeriksaan browser mencakup dashboard master, batas akses agen, tampilan mobile dan website player. Tiga game yang belum diverifikasi tetap tidak dapat diluncurkan.

| Data simulasi | Shared / net | Split / gross |
|---|---:|---:|
| Penjualan koin | 10.000 | 5.000 |
| Withdraw berhasil | 1.500 | 100 |
| Saldo player akhir | 8.500 | 4.900 |
| Invoice 20% | 1.700 | 1.000 |

Closing bulan November dipercepat khusus simulasi. Invoice tetap sama saat closing diulang. Ini bukan tutup buku operasional bulan berjalan.

Bukti: [HTTP dan pembersihan akun uji](evidence/agency-deployed-smoke-2026-11-03.json), [browser](evidence/agency-deployed-ui-2026-11-03.json), [panduan akses dan deployment](PLAYGROUND_AG_DEPLOYMENT_CHECKPOINT_2026-11-03.md).

**Batas bukti:** protokol game diuji dengan adapter sintetis; ini bukan bukti ketiga native game telah cutover. Payment worker merupakan simulator, bukan gateway QRIS/VA/disbursement nyata. Chatvice privat/SSO belum diuji live.
