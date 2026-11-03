# CP16: Source player identity, authoritative virtual balances and reviewed commands

## Scope
UNO LUCK isolated staging pilot only. The original game services, game odds, owner authentication and existing machine keys are unchanged. This release is not cash, payments, cross-game identity, KYC, withdrawals, all-game wallet sync or full Xaxino parity.

## One balance authority
The actual game accounts/ledger remain authoritative. PostgreSQL records signed source observations and reviewed requests, not a second spendable balance. Original local DEMO_COIN wallet records are explicitly separate. Source-player identity is keyed by game, environment, persistent stream UUID and salted player reference identical to CP15 round observations. No raw account ID, guest cookie, email or identity claim is exported.

## Source implementation
A SQLite trigger records each real ledger insertion in its original transaction. Existing accounts receive an explicit opening snapshot at CP16 cutover; prior ledger history is not fabricated. Welcome creation is atomic. The source checks captured balances against actual accounts and ordered player chains. Failed writes or failed capture cannot be reported as applied.

HTTP delivery occurs after commit, via separate scoped signing credentials, purpose-specific HMAC, nonces, pinned stream and verified response signatures. Stored acknowledgments and command receipts survive restart. Commands require source-side enablement and use exact integer nonredeemable credits, bounded to 1,000,000, expected player revision, expiry and no active game round. Each command has one durable idempotency identity. A changed same-ID command is rejected.

## Administrative workflow
- Source Wallets joins CP15 observed player references to the correct source identity and shows reported balance, ledger, timestamps, freshness and coverage.
- Support or Owner may submit a credit/debit request with reason and idempotency ID. Submission does not change balance.
- Only Owner may review. Approval queues a command only if the source snapshot is recently matched and both sides permit commands. Rejection dispatches nothing.
- States remain distinct: pending_approval, queued, awaiting_source_confirmation, applied, rejected_by_source, rejected_by_admin.
- An applied result is accepted only when a signed source receipt matches an actual received source command ledger entry and expected revision. Timeout or network failure never means success.
- Writes and administrative audit records share PostgreSQL transactions. Source application, its ledger entry and immutable result share a SQLite transaction.

## Security
Existing MFA/CSRF/RBAC is retained. The new transport uses GAMEOPS_WALLET_KEYS on the receiver and GAMEOPS_WALLET_KEY_ID/SECRET on the source, never replacing GAMEOPS_BRIDGE_KEYS or CP15 supplemental keys. Staging data does not enter production. Source commands are unsupported for production keys in this pilot. No production admin test account or authentication bypass is created.

## Operator controls
- GAMEOPS_WALLET_ENABLED=1 enables source observation/sync. Turning it off stops network sync, but an installed ledger capture trigger remains to retain coverage.
- GAMEOPS_WALLET_COMMANDS_ENABLED=1 enables source command polling. Receiver key allowCommands must also be true. Disabling either prevents new dispatch/application; old accepted results can still reconcile.
- Key streamId must equal the actual persistent CP15 stream. Rotation needs a deliberate new key/configuration; it does not change identity or account data.
- A stale source, unmatched chain or pending source prefix is visibly not verified. Approval fails closed.
- Pilot full-manifest limit: 100,000 captured entries per stream. Reaching it blocks reconciliation/commands until a separately tested incremental scheme is implemented. Do not roll out this bounded pilot indiscriminately.

## Tests and release gates
Real loopback CI boots original UNO HTTP game, SQLite persistent outbox and actual Playground server.js with isolated PostgreSQL. It checks source account opening, welcome/daily/refill/stake/payout, identity mapping, request/review separation, real source credit/debit, idempotency, concurrent revision conflicts, active-round rejection, audit rollback, unavailable receiver, restarts, forged/replayed transport, role/scope boundaries and real HTTP browser desktop/mobile. CP14 and CP15 regressions rerun. No mocked API is used for acceptance. No live source failure injection or real user balance changes are permitted in QA.

Deployment requires successful frozen-source CI and terminal Railway SUCCESS. Live read-only/pilot gameplay verification is separate from privileged production-account tests. Do not claim a live owner command was tested when only CI test accounts were used.

## Remaining roadmap
Other game exporters, authoritative cross-game transfer, full settings runtime consumers, notification delivery, identity/KYC/OAuth providers and deepest Xaxino reference parity are separate milestones. Source command code completion does not mark those complete.
