# CP15: persistent source observations and scoped Game Data

Baseline: Playground CP14 main dcea89b0d1d2135c0b074061f31cffce9dbfc244. Target 0.15.0.
UNO source baseline: exact live staging revision c8327f47086d524a43559e297a42bef183d514e4, not the current unrelated UI branches.

## Source audit and rollout boundary
UNO Orbit settles its final third pick server-side in a SQLite transaction, updates the game balance, and inserts the `spins` record. Legacy spin mode also records a committed server outcome. Source payout can be capped; exported payout must therefore be `stake + delta` (effective credited payout), not a theoretical prize multiplier. No game probabilities, outcomes, UI assets, prizes or balance mutations are changed by this release.

The original live UNO service defaults its game database to an ephemeral /tmp path. Repointing it would risk losing its existing state. Therefore CP15 runs on a NEW isolated staging pilot with its OWN persistent volume and guest database. The original UNO service, audio volume, other QA services, Skygate and Mahjong are not deployed or altered.

## Durable source outbox
- SQLite outbox insert is part of the exact same transaction as a completed source round. The first two picks emit no completed event. If capture fails, the round transaction rolls back.
- Duplicate request/round IDs do not allocate another event or sequence. Queue rows, retry/backoff, leases, stream identity and pseudonym salt survive process/container restart when the volume is retained.
- A worker sends after commit, with per-game HMAC and a fresh request nonce. Only a valid signed receipt for the exact event/stream/sequence marks acknowledged.
- No request token, name or raw source account ID leaves the source. Player references are salted HMAC pseudonyms.
- Source manifest is rebuilt from actual source `spins` rows after an explicit coverage cutover, not only from queued records. A missing capture is a mismatch, never a false success.
- Failed delivery remains pending and retried. The existing receiver limits observations to 30 days; a long outage beyond that limit needs explicit review, not silent deletion.

## Receiver and reporting
- Existing signing keys are preserved. A supplementary key array permits only the new UNO staging pilot to send rounds.
- Atomic idempotent ingestion binds game, environment, stream UUID, source sequence, event and round. Conflicting IDs or payloads return 409. Decimal amounts stay decimal strings and PostgreSQL numeric, never JS floating-point conversion.
- Read-only `/api/admin/data/*` APIs and protected `/data` page derive dashboard, Game Log, pseudonymous player detail and reconciliation from ONE signed observation table.
- Production is the default scope. Staging cannot be combined with production totals. Existing legacy rows are kept separately and explicitly excluded, not imported or double-counted.
- Viewer cannot access player detail and cannot receive player references in round responses. No new write or impersonation action.
- Source reconciliation checks count, exact sums and a deterministic ordered manifest through a declared prefix. UI distinguishes missing, empty, mismatch, stale and matched-prefix states. A heartbeat is not sufficient for data completeness; matched-prefix is not wallet verification or financial settlement.

## Acceptance gates
- Existing CP14 regression and fault-injection tests must remain PASS.
- UNO original game tests plus atomic outbox tests: source transaction rollback, replay idempotency, effective capped payout, missing-capture detection and persisted retry.
- Actual FastAPI source and actual Express/PostgreSQL receiver in CI: final pick delivery, receiver outage, sender/receiver restart, retry, duplicate/conflict, scope isolation, exact decimal precision, out-of-order events and reconciliation.
- Actual HTTP Playwright (no API mocks): scoped dashboard, round detail, player detail, source reconciliation and mobile 390px; no production accounts or keys used.
- Merge only after exact source tests PASS. Deploy receiver and isolated pilot separately; verify terminal SUCCESS and real signed source/receiver acknowledgment. No final deployment claim is made by this source document.

## Remaining roadmap
This closes the data-pipeline pilot, not CP16-19 or all Xaxino parity. Original game migrations, full settlement feeds for Skygate/Mahjong, cash-equivalent wallets, KYC, OAuth, outbound email/SMS/push, bonus/fee consumers and exhaustive live vendor click-through require separate verified integrations. Do not label unavailable providers active.
