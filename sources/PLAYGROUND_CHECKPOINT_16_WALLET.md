# Playground CP16: Source-authoritative Virtual Wallet, Live Staging Release

Release evidence checked: 2026-11-03. Playground **v0.16.0** deployed; source wallet protocol **staging UNO only**. This checkpoint does **not** claim complete Xaxino parity, payments, KYC, original UNO source migration, or cross-game balance sync.

## GitHub and Railway
- Admin PR #16 merged: https://github.com/9dbit/Playground/pull/16
- Tested admin source: 0e9730cd98667cfa7ccfb280471091fb70d3b09f; merged admin main: d29631bdd6db2ea416dcc87d1b5262f4a3ad0b9e.
- Final admin Railway deployment (two wallet config gates enabled and staging-scoped): 94d78879-d723-42f0-b185-e3c0309346d0, terminal SUCCESS; runtime is v0.16.0.
- UNO pilot source pinned at da102743ac1d1a91819219eb8b8944dec86a0854, corresponding review PR https://github.com/9dbit/uno-luck/pull/34 (draft to prevent affecting original main).
- Isolated UNO pilot Railway deployment 4dafe599-fc1d-46f1-9adc-a29e7cc54a39: terminal SUCCESS, original dedicated /data/uno-luck volume preserved. Source is NOT the original UNO guest service.
- Original UNO staging is unchanged at source c8327f47086d524a43559e297a42bef183d514e4, deployment ebe2797b-7af6-4d65-a880-31afcf609f4d, terminal SUCCESS.
- Admin entry: https://playground-admin-production.up.railway.app/wallet
- Read-only round data: https://playground-admin-production.up.railway.app/data?game=uno-luck&environment=staging
- Pilot guest game: https://uno-game-data-pilot-staging.up.railway.app/

## End-to-end verification
- Exact final tested admin head CI: https://github.com/9dbit/Playground/actions/runs/41574913745
  - 82/82 backend regressions (zero skipped/failures).
  - CP14 actual-server, PostgreSQL, browser: 26/26 PASS.
  - CP15 source-to-report actual HTTP checks: 8/8 PASS.
  - CP16 actual UNO HTTP, real SQLite, signed HMAC wallet receiver, disposable PostgreSQL, browser mobile390: 8/8 PASS, zero failures, productionContacted=false.
  - CP16 tests include new guest original source balance 1000, source owner-reviewed +100 credit => 1100, 25 debit =>1075, refused 10000 debit with unchanged balance, replay rejection, stale versions, restart & source ledger matching, guest request idempotency, CSRF, MFA owner scope.
  - Original CP14 and CP15 standalone workflows also PASS on exact tested branch head.
- UNO wallet source CI https://github.com/9dbit/uno-luck/actions/runs/41571111922 PASS; underlying pytest 187 passed, 1 skipped.
- Live after final gate activation https://github.com/9dbit/uno-luck/actions/runs/41575942318 PASS:
  - Admin public health v0.16.0; unauthenticated admin wallet HTTP401.
  - Pilot game public health200; guest wallet without guest cookie HTTP401.
  - A new pilot guest receives 1000 nonredeemable DEMO_COIN in UNO.
  - Staging source journal version1/1000 was acknowledged signed by Playground and reconciliation was **matched**, receipt version1.
  - No cash operations or production owner credit/debit were executed by the live smoke.
- Source staged wallet commands are enabled (GAMEOPS_WALLET_COMMANDS_ENABLED=1) only for isolated UNO, and admin intents are enabled (GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED=1) but restricted to the signed staging UNO key, owner role, MFA, CSRF, fresh/matched ledger, no active round and allowed amount.
- Unknown keys and signatures do not authorize changes. Production game-round counters are never mixed with pilot data.
- No live owner user credentials were consumed. **Actual production-owner credit/debit click has not yet been directly exercised in live service**, although full synthetic-owner real HTTP integration passed in CI. Do not misrepresent that distinction.

## UX and API
- /wallet Player Source Balance: source pseudonym (never inferred email), scoped virtual credits, last source sync, ordered immutable entries, command status and verification. Deep-link from CP15 observed player to source wallet.
- /wallet Diamond Requests: real guest cookie-backed requests; Owner approve/reject. Approval does not apply credits. Only source journal evidence and matching signed receipt can change a queued command to applied.
- Owner-only credit/debit: 1-10000 DEMO_COIN, reason >=8 chars, version CAS, one active command per wallet, idempotent command IDs, expiry, no negative balance or cap overflow.
- No game outcome, jackpot odds, payouts, audio or original gameplay/UI changed.

## Recovery constraints (important)
The CP16 source writes persistent SQLite journal triggers that depend on the CP16 application registering SQL functions. If wallet integration needs to be paused, set source GAMEOPS_WALLET_COMMANDS_ENABLED=0 and admin GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED=0. Optionally set GAMEOPS_WALLET_ENABLED=0 while **keeping the deployed CP16 source image**, which continues to register the required functions for existing triggers. DO NOT downgrade the existing pilot DB to the old CP15 image without a verified maintenance migration removing/adapting triggers; the old image may break writes. Do not delete or reset the existing pilot volume.
The original UNO staging service and its sound volume are separate and unaffected.

## Outstanding boundaries
- No real money, payment, deposits, withdrawals, financial reconciliation, merchant cash balance, KYC, user impersonation or live jackpot controls.
- Skygate/Mahjong round-wallet exporters, cross-game player identity and balances, external SMS/email/KYC providers, and complete Xaxino deepest-page parity are CP17+ tasks.
- CI verifies owner commands end-to-end; a live human owner should confirm the intended admin UI flow before broader rollout beyond this pilot.
