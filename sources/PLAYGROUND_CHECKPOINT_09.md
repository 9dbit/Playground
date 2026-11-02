# Playground GameOps: Checkpoint 09 - Signed Game Bridge

Date: 2026-11-02. Baseline: CP08 `715da494b2fff4fdfe73f9c52715e8e33fb2235f`.
Scope: transport and connectivity milestone, not a complete game-settlement migration.

## Scope distinction

- **Heartbeat online** means an authorized game runtime probed its local `/health`, sent a scoped signed heartbeat, and received an authenticated acknowledgement.
- **Round ingestion enabled** is a separate permission. All three production configuration entries in this rollout set `allowRounds: false`.
- **Round data verified** is true only after the bridge accepts an actual server round observation. No gameplay records are created by heartbeats.
- No game odds, outcomes, rules, wallet balance, account identity or payout logic is modified by this checkpoint.
- Existing admin authentication, mandatory MFA onboarding, session encryption key and account passwords are preserved. Do not rotate SESSION_SECRET as part of game integration.

## Delivered components

1. `/api/v2/game-bridge`: raw-body HMAC-SHA256 transport with immutable per-game/environment key scope, canonical request path, timestamp freshness and a persisted nonce ledger.
2. An authenticated response receipt tied to the request nonce and response bytes, verified by both Node and Python agents.
3. Retired shared-secret `/api/v1/game-events` returns 410. This closes the cross-game authorization bypass inherent in the CP07 receiver.
4. Durable nonce and event deduplication. Replayed requests return 409; retries use fresh nonces; identical semantic events return duplicate acknowledgement; conflicting content returns 409.
5. Exact virtual-unit observations use `NUMERIC(38,12)` and decimal strings. They remain separate from legacy bigint counters. No float conversion or silent rounding is allowed.
6. A protected Game Bridge monitor at `/integrations`: configured/awaiting/online/stale/degraded states, deployment environment, reported build, last verified heartbeat, and nested paginated observations.
7. Read-only monitor access is allowlisted for the four CP08 roles. No browser API exposes secrets or permits key mutation.
8. Heartbeat agents copied into each native runtime; disabled without explicitly configured environment variables. Failures are isolated from game requests.

## Source audit / correct deployed branches

| Game | Repository and deployed branch | Source finding | CP09 rollout |
|---|---|---|---|
| Skygate 5000 | 9dbit/Skygate, main | Node server serves browser game and Studio. No authoritative server round-settlement hook was found in server.mjs. | Heartbeat-only native Node agent |
| UNO LUCK | 9dbit/uno-luck, fix/uno-v13-solid-uno-led-emissive-20261019 | FastAPI; server-side completed rounds in SQLite; default database file is under /tmp unless UNO_SPIN_DB_PATH overrides it. Several separate QA branches exist. | Heartbeat-only on the existing uno-luck-web staging service; do not replace its UI branch |
| Mahjong Wild | 9dbit/Mahjong-legend, main | Django + PostgreSQL. Round amounts are Decimal(38,12). Separate web and worker services. | Heartbeat-only in web WSGI workers; worker heartbeat readiness is checked by /health |

The two Mahjong web worker processes may each send a heartbeat. The monitor groups them as one game, not two independent integrations.

## Runtime configuration

Receiver `GAMEOPS_BRIDGE_KEYS`: JSON array of entries with `id`, `game`, a new independent 32-byte hex `secret`, `environment`, `enabled` and `allowRounds`.
Only one environment per game may be configured in a given admin deployment. Rotation may temporarily include multiple key IDs for that same game/environment. Removing a key invalidates its signatures.

Sender variables: `GAMEOPS_BRIDGE_ENABLED=1`, `GAMEOPS_BRIDGE_KEY_ID`, `GAMEOPS_BRIDGE_SECRET`, `GAMEOPS_ENVIRONMENT`.
The receiver URL is restricted to the verified Playground deployment. Redirects are not followed. Do not use frontend-exposed env prefixes, place keys in browser bundles, or log signatures and payloads.

New integration secrets belong only in Railway variables. They are never included in this document, source code, screenshots or downloadable reports.

## Protocol

Headers: X-GameOps-Key, X-GameOps-Timestamp (Unix seconds), X-GameOps-Nonce (16 random bytes as hex), X-GameOps-Signature.
Signed bytes are newline-joined: `gameops.v2`, `POST`, `/api/v2/game-bridge`, timestamp, nonce, SHA256(raw body).
Signature is HMAC-SHA256 using the 32-byte secret. Freshness tolerance is five minutes. Nonces remain in PostgreSQL for eleven minutes, longer than the full acceptance window.

Heartbeat contains schema_version=2, type=heartbeat, game, environment, version, health, deployment and capabilities. Agents declare only heartbeat capability in this release.
Round observations require explicitly enabled scope, DEMO_COIN currency, pseudonymous hashed player reference, stable event/round IDs, exact nonnegative decimal strings and an event timestamp within the allowed window. The receiver does not equate a signed heartbeat with proof of settlement.

## Tests and verification

- Unit: malformed configuration, key/environment scope, byte-level signatures, Node/Python interoperability, replay freshness, decimal precision, receipt verification, authorization and disabled agent behavior.
- PostgreSQL integration: real app in isolated random schema, legacy retirement, unauthorized reads, persisted nonce replay, scope checks, exact decimals, concurrent event idempotency, conflict detection, invalid currency/PII, stale state, restart persistence.
- Browser: status distinctions, explicit round gate, escaped names, exact decimal rendering, observation drilldown, desktop and 390px viewport.
- Production validation is recorded separately in PR release comments after actual deployment. Never use the owner's password/MFA or insert synthetic rounds into production to manufacture a passing status.

## Remaining work

- Authoritative round exporters for UNO and Mahjong with transactionally durable outboxes and acknowledgement cursors. Check source storage persistence first, especially UNO's configurable SQLite path.
- Skygate needs a server-authoritative round boundary before any financial or authoritative settlement data can be accepted; client-reported results must not be relabelled as verified.
- Preserve exact game-specific units when mapping telemetry to canonical reports; do not coerce Mahjong Decimal amounts into existing integer records.
- Wallet ledger, KYC, external delivery and admin game-control commands remain disconnected.

## Source guidance

- OWASP Webhook Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html
- Node crypto HMAC and timing-safe comparison: https://nodejs.org/api/crypto.html
