# Playground Agency — hasil simulasi 3 November 2026

Hasil: **25 lulus, 0 gagal**. Lingkungan: PostgreSQL WASM (PGlite), Express lengkap, HTTP nyata, dan Chromium headless. Data agen/pemain seluruhnya sintetis. Tidak ada pembayaran atau disbursement eksternal.

Regresi existing: 48 lulus, 5 dilewati karena PostgreSQL native belum tersedia, 0 gagal. Workflow PostgreSQL 18 tersedia dalam perubahan, dan akan diverifikasi setelah push yang sudah diizinkan.

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

**Batas bukti:** protokol game diuji dengan adapter sintetis; ini bukan bukti ketiga native game telah cutover. Payment worker merupakan simulator, bukan gateway QRIS/VA/disbursement nyata. Chatvice privat/SSO belum diuji live.
