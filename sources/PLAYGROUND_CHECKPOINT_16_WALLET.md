# Playground CP16: Source-of-Truth Virtual Wallet (staging)

Status: **implementation branch, not production-verified** until CI + isolated live pilot complete.

## Scope
- Preserve CP15 source-backed observations, legacy counters, authentication, MFA and existing game state.
- Isolated UNO staging pilot is the only supported wallet source. Zero real-money value.
- Source SQLite has exclusive authority over balance; PostgreSQL stores signed, sequential receipts and admin command intents, not independently editable balances.
- Stable pseudonymous source player IDs are scoped to game + staging + immutable stream.
- Ledger entries verify monotonic per-account version, exact before/after + delta and SHA256 chain; duplicate/replayed entries must be identical.
- A source snapshot with version/balance/manifest is marked matched only when all three equal receiver's contiguous journal.
- Guest request carries an HttpOnly-session-associated source ID. Owner approval queues virtual credits; never reports balance applied.
- Admin credit/debit is owner-only with MFA, CSRF, reason, immutable command hash and per-wallet in-flight lock. No network inside SQL transaction.
- A matching source command receipt and wallet journal entry are both required to mark applied; network failures remain pending.
- Signed HMAC wallet channel is distinct from CP15 round/heartbeat keys and all features default off.
- Never alter cards, odds, payouts, money, production virtual wallets or the original UNO guest service.

## Deployment gating
1. Keep old original UNO service and audio volume unchanged.
2. Run full server PostgreSQL + actual UNO HTTP staging acceptance in disposable CI schema, including negative cases.
3. Only after acceptance deploy CP16 UNO code to the isolated pilot branch, with its existing persistent volume.
4. Configure separate GAMEOPS_WALLET_KEYS on admin and GAMEOPS_WALLET_KEY_ID, GAMEOPS_WALLET_SECRET on isolated UNO pilot without touching existing keys.
5. Enable GAMEOPS_WALLET_ENABLED=1 for passive journal capture. Check source/receiver match and source drift; default admin GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED=0.
6. Enable GAMEOPS_ADMIN_WALLET_COMMANDS_ENABLED=1 and GAMEOPS_WALLET_COMMANDS_ENABLED=1 only for pilot after a guarded, confirmed real HTTP credit/debit acceptance.
7. Never call a source write successful on an HTTP response alone. The source ledger proof must be present.
8. Audit any migration or historical mismatch without fabricating reconciliation data.

## Limitations
Not a real-money system. No cross-game identity, KYC, deposits, external payments, actual diamond value or withdrawals. Not all Xaxino subpages are live.
