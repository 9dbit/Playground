# Playground Agency implementation checkpoint — 2026-11-03

Baseline: Playground `9bbf6957f1296f9d417de293ee843d290bd147b8`, v0.16.0. Work branch: `feat/agent-platform-20261103`, v0.17.0. This checkpoint implements and tests the **sandbox operating workflow**. It is not a declaration that AG00–AG12 or production cutover are complete.

The approved plan and both research documents are included alongside this file. No existing player balance is imported, summed, or silently converted. Existing GameOps accounts, game settings and source wallets retain their own tables and behavior.

## Delivered behavior

- Independent agent staff and player authentication; owner, supervisor, finance, marketing, support and analyst permissions; authenticator enrollment, password plus TOTP step-up, immediate session revocation and IPv4/IPv6 allowlists. Agents cannot call master settings, provider selection or all-agent endpoints.
- Tenant-scoped catalog/entitlements, release readiness, one-use launch tokens, server HMAC, nonce replay detection, reserve/settle/void and exact integer amounts. Game risk pool is separate from agent sellable stock. Existing games start registered and require explicit verified release promotion.
- PostgreSQL atomic paired ledger entries with immutable journals, balanced-per-unit deferred constraint, nonnegative balances, idempotency and tenant serialization. Committed journals cannot accept extra entries. Cash, stock, player available/reserved, game liability and fees are separate books.
- Stock request and Playground allocation approval. Unsold allocation does not create revenue. Checkout reserves stock. A verified simulated payment atomically consumes stock, credits the player and records a sale. Late payment without stock remains a visible exception.
- SHARED and SPLIT simulated gateway accounts with frozen transaction account/version. Payment received and gateway settled are distinct. Manual bank deposit approval rejects reused bank references. Supervisor overrides cannot manufacture payment evidence.
- Withdraw reserve, new-beneficiary review, `<1,000,000` auto candidate and `>=1,000,000` review, cumulative checks, separate cash funding, single-use supervisor approval, durable payout queue, unknown/paid/failed/reversed outcomes. Restricted players can log in, see history and request a reviewed withdrawal; new deposits and rounds are blocked.
- Gross/net contracts default 20%, WIB monthly statements, immutable invoice snapshots, historical-rate negative-basis credits, idempotent close and invoice-payment journals. Refund and paid-withdrawal reversal are corrections, not duplicate fee deductions.
- Master `/agents`, agent `/agency`, public `/site/:slug`, cashier, staff, transactions, inventory, reports/CSV, CMS revision/CAS/publish/schedule/rollback, escaped content, SEO/canonical, verified-domain routing, tickets, audit and operational guidance.
- Chatvice wrapper, narrow CSP and public merchant mapping controlled by Playground. Changing dashboard tenant reloads the document and logout clears the widget context. Private transaction lookup and verified private Chatvice SSO are **not enabled**.

## Verification

`npm test`: 48 passed, 5 skipped locally because those legacy integration tests require a native PostgreSQL instance. No failures.

`AGENCY_BROWSER=true npm run test:agency`: **25 passed, 0 failed** (24 API/system scenarios plus one browser scenario). Runs the full Express application against disposable PostgreSQL WASM (PGlite), real HTTP sessions and Chromium. The report is written to `test-results/agency-system.json`; desktop/mobile screenshots are in the same directory. These T01–T24 identifiers belong to this executable suite and do not replace the separately numbered acceptance matrix in the approved plan.

The GitHub workflow `.github/workflows/agency.yml` completed successfully on published commit `76fa31b7ac7fea70517886db96e85af9aef69e20`: **82 regression tests passed, 0 failed, 0 skipped**, plus **25 agency scenarios passed, 0 failed**, against native PostgreSQL 18 and Chromium. All five workflows succeeded. See [native CI evidence](evidence/agency-ci-2026-11-03.json) and [the actual run](https://github.com/9dbit/Playground/actions/runs/41622141420).

The separately deployed Railway sandbox also passed authenticated HTTP exercises for both SHARED/net and SPLIT/gross tenants, including automatic and manual deposit, idempotency, supervisor approval, automatic payout, funding separation, immutable monthly close, CSV isolation and support tickets. Chromium verified the deployed master and agent dashboards, mobile layout and public storefront. See [deployment checkpoint](PLAYGROUND_AG_DEPLOYMENT_CHECKPOINT_2026-11-03.md) for results and access.

The suite covers cross-tenant IDs, role/CSRF, duplicate and conflicting payments, pending/settled cash, reused bank references, invalid overrides, late payment and stock shortage, bound supervisor approval, timeout/reversal, threshold and split funding, signed game protocol, concurrent spend, monthly credits, CMS injection/rollback, session/IP revocation, journal invariants, close replay, legacy routes, fault rollback, restricted-player funds access, forged signatures/nonces, domain isolation, CSV scope and Chatvice merchant rejection. The worker scenario verifies automatic payment, independent settlement recovery after interruption, automatic payout and repeated-worker idempotency.

## Remaining acceptance work

| Plan | Status / concrete remaining work |
|---|---|
| AG00 | Baseline/source audit recorded; operational jurisdiction, real provider and merchant account inputs still required. |
| AG01 | API/query isolation and composite tenant foreign keys tested. RLS, idle-session policy, password recovery and independent database-role hardening remain before live rollout. |
| AG02–03 | Central schema, sessions, catalog and wallet invariants implemented for sandbox. Production balance migration and reconciliation must use approved opening balances. |
| AG04 | Central game protocol is implemented and simulated. Native UNO, Mahjong and Skygate wallet-authority cutovers are **not completed** by a synthetic adapter test. All game releases remain gated until native recovery/precision tests pass. |
| AG05–07 | Simulator cashier and durable states implemented. Real QRIS/VA, signed provider callbacks, disbursement/status lookup, provider fees and provider-sandbox evidence require the actual provider/account integration. TOTP works; biometric/WebAuthn is not implemented. |
| AG08 | Fee/invoice core implemented and simulated. Native provider reconciliation and accounting migration remain rollout prerequisites. |
| AG09 | CMS and verified host routing implemented. Hosting DNS/TLS provisioning needs the real domains. Arbitrary raw custom scripts are rejected; reviewed sandboxed vendor registry and analytics execution remain. |
| AG10 | Functional operating dashboards, scoped export, exceptions, tickets and guidance implemented. Paginated large exports, notifications delivery, richer risk cases and complete player-limit lifecycle remain. |
| AG11 | Embedding configuration and SOP fallback implemented. Live merchant mapping/domain verification and server-verified private identities across Chatvice endpoints remain. No private lookup is claimed. |
| AG12 | Local API/browser simulation, native PostgreSQL CI, isolated service/schema deployment and deployed HTTP/browser checks completed. Native-game cutover, restore drill, production load/monitoring and live pilot are still required. |

## Runtime configuration

Required: `DATABASE_URL`, random `SESSION_SECRET` (32+ characters), bootstrap `ADMIN_USERNAME`/`ADMIN_PASSWORD`, and HTTPS `PUBLIC_SITE_URL` in a deployment. Existing GameOps password-change and MFA enrollment remain enforced.

A separate sandbox service may set `DATABASE_SCHEMA=agency_sandbox_v1`. It creates and uses that validated namespace with **no public-schema fallback**. Do not set this variable on the existing production service. The shared database remains infrastructure only; all sandbox application tables use this namespace.

`AGENCY_SIMULATION_WORKER=true` enables simulated automatic QRIS/VA confirmation/settlement and simulated payout processing. No external bank or provider is contacted. Master simulation actions remain available for timeout/failure/reversal drills.

`AGENCY_GAME_KEYS` is a JSON array of `{id,game,environment,secret,enabled}` server credentials. Keep secrets out of browser code and repositories. Each game/environment has a separate key.

Optional `AGENCY_CHATVICE_ORIGIN`, `AGENCY_CHATVICE_MASTER_MERCHANT`, and `AGENCY_CHATVICE_TENANT_MERCHANTS` (object keyed by tenant slug, with `staff` and `public` merchant IDs) configure approved widgets. Leave these unset until domain and context isolation are verified. SOP version is `2026-11-03.1`.

Rollback for the new sandbox: stop its worker, preserve evidence/database, disconnect the sandbox service's source or redeploy its preceding tested commit. Never restore an old balance snapshot over posted journals. Nothing in this checkpoint resets legacy game volumes or production balances.

## Publication status

Feature branch `feat/agent-platform-20261103` is published with [draft PR #18](https://github.com/9dbit/Playground/pull/18). The separate [agency sandbox](https://playground-agent-sandbox-production.up.railway.app/agents) reached Railway `SUCCESS` on 2026-11-03 at 10:51:05 UTC. The deployed application is pinned to the tested code commit `76fa31b7ac7fea70517886db96e85af9aef69e20`; subsequent evidence-only commits do not change the running build. Existing production services were not redeployed. See [release evidence and access instructions](PLAYGROUND_AG_DEPLOYMENT_CHECKPOINT_2026-11-03.md). Production cutover and real gateway activation are outside this sandbox release.
