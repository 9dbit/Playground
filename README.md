# Playground GameOps Control Center

Original multi-game administration console inspired by the structure of the Xaxino reference. Node.js 20+, Express and PostgreSQL. This feature branch provides the **0.17.1 agency sandbox** and opt-in master credential recovery through service variables.

## Agency sandbox

- [Benchmark Oxplay: workflow, fitur yang diterapkan, batas demo dan backlog](sources/OXPLAY_BENCHMARK.md).

- [Master dashboard](https://playground-agent-sandbox-production.up.railway.app/agents) and [agent dashboard](https://playground-agent-sandbox-production.up.railway.app/agency).
- Public demonstrations: [shared gateway account](https://playground-agent-sandbox-production.up.railway.app/site/demo-shared) and [split deposit/disbursement accounts](https://playground-agent-sandbox-production.up.railway.app/site/demo-split).
- [Release, access and deployed verification](sources/PLAYGROUND_AG_DEPLOYMENT_CHECKPOINT_2026-11-03.md), [implementation status](sources/PLAYGROUND_AG_IMPLEMENTATION_STATUS_2026-11-03.md), and [test results](sources/PLAYGROUND_AG_UAT_2026-11-03.md).

The sandbox uses a separate service and database schema. Payments, payouts and coins are simulated. Native games remain gated pending their wallet-authority cutovers. Private Chatvice SSO and real payment-provider integration are not enabled.

Master operational pages (`/engine`, `/engine-v1`, `/integrations`, `/data`, `/wallet`, `/agents`) load the authorized Chatvice widget for `m_36f76fcbe11167ed`, version `1793889257`, after confirming a fully enrolled master session. The launcher works independently of agency selection. Login and Security Center do not load third-party scripts; agent and player widgets retain their separate tenant configuration. The master widget uses standard Chatvice visitor sessions, with no account data or private SSO supplied by Playground.

## Application
- Login: https://playground-admin-production.up.railway.app/login
- Health: https://playground-admin-production.up.railway.app/health
- Security Center: `/security`
- Admin: `/engine`; previous UI: `/engine-v1` (both use current authentication and permissions)

## First login after Checkpoint 08
Existing Checkpoint 07 sessions are invalid. Sign in with the existing owner credential, change the temporary password, and verify an authenticator before entering the dashboard. Save the eight single-use recovery codes privately. Enrollment uses a manual time-based setup key, not a third-party QR service.

By default, the environment username/password only seed the first owner when the account table is empty. With `ADMIN_CREDENTIALS_SYNC=true`, changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` and deploying updates the same original owner, revokes that owner's sessions and preserves the registered authenticator. Unchanged variables do not overwrite a password changed inside Security Center. Username: 3–64 lowercase letters/digits/`.`/`_`/`-`, beginning with a letter or digit. Password: 15–128 characters. The login page's “Lupa password atau username?” section explains the active recovery mode.

If the environment values are unchanged but must be reapplied, change the optional `ADMIN_CREDENTIALS_REVISION` marker and deploy. This is not a password and is applied once per configuration change. Recovery affects the original master only; it does not rename another user, reset MFA or enable a disabled account. See [the recovery guide](sources/PLAYGROUND_MASTER_ACCESS_RECOVERY_2026-11-05.md). Keep passwords, setup keys and recovery codes private.

## Features
- Deep sidebar navigation and 19 System Settings modules
- Games -> versioned Game Edit, artwork and immutable event drill-downs
- Players -> User Detail, profile metadata and per-user round history
- Internal ticket threads, request metadata review, notifications and subscriber records
- Basic CMS with public informational pages, robots.txt and sitemap.xml
- Database-backed administrator accounts, Owner / Operator / Support / Viewer roles
- Mandatory password change and TOTP enrollment, single-use recovery codes
- Persistent session revocation, CSRF/origin checks, authentication rate limits and actual actor audit identity
- Signed inbound DEMO_COIN events; **no external game adapter or wallet settlement is connected**

## Development and testing
Configure `.env.example`, start PostgreSQL, then run:

```bash
npm install
npm test
npm start
```

`npm test` runs syntax/unit checks. The database integration suite requires `TEST_DATABASE_URL`; it creates and removes its own random test schema. Never point that variable at production. GitHub Actions runs PostgreSQL 18 integration tests and a separate mocked browser test. The browser harness is `tests/security-ui.cjs` and produces CI screenshots with synthetic accounts only.

Database initialization is additive and idempotent. Security bootstrap is serialized by an advisory lock. New secrets must be configured privately in the runtime environment.

## Deployment and recovery cautions
Do not roll back to CP07 after account migration without first taking the app offline: CP07 would restore obsolete environment-password authentication. Prefer a forward fix.

`SESSION_SECRET` now encrypts authenticator material and protects recovery-code hashes. Do not rotate it without migrating those keys. Lost authenticators can use an unused recovery code; operator-assisted recovery when all codes are lost is not implemented yet.

Native TOTP is implemented. This branch adds an agency ledger, cashier simulator, billing and worker; OIDC, passkeys, KYC, external notification delivery, native game cutovers and recurring backup verification remain separate milestones. Real-money settlement, user impersonation and live win-rate manipulation are not supported.

## Checkpoints
- `sources/PLAYGROUND_CHECKPOINT_08.md`: security implementation, onboarding, acceptance coverage and remaining work.
- `sources/PLAYGROUND_CHECKPOINT_07.md`: baseline deep-admin features and disconnected integrations.

Agency hero banners: open **Website & SEO → Edit → Hero banner** to upload or replace a JPG/PNG/WebP, preview it, or choose **Delete banner**. Click **Simpan**, then **Publish** on the page to update the storefront. The browser optimizes uploads up to 10 MB / 16 megapixels; the server decodes and re-encodes them as WebP (up to 1600 px and 500 KB). Banner assets persist in PostgreSQL across redeploys, are tenant-owned, and have a 50 MB per-tenant storage quota. Repeated identical uploads are deduplicated. Deleting a banner removes its content reference; historical assets remain available for rollback. Uploaded images are public website assets at unguessable URLs, so upload only material intended for publication. Staff need the Website permission.

64COR is the Playground storefront at https://playground-agent-frontend-production.up.railway.app, backed by tenant `64cor`. On the authorized `agency_sandbox_v1` deployment, startup bootstraps this tenant once, preserving subsequent CMS, staff and balance changes. No funds or staff passwords are created by bootstrap. Master owners manage it under `/agents` by selecting **64COR**; create agency staff under Staff & IP when separate agent access is needed. Allocate coin stock through the normal master workflow before testing deposits.

The storefront consumes published content: `home` controls title/description/canonical and the first banner; `banner-01`, `banner-02`, etc. are additional slides; `promo-01`, etc. are promotions. Upload/replace/delete images, edit destination links, then Save and Publish. Initial existing artwork is imported as editable CMS records. `/site/64cor` redirects to the actual 64COR frontend.

Player registration/login/logout, profile, password change, favorites, inbox read state, wallet, deposits, withdrawals, transactions, rounds, tickets and game launch use Playground APIs with session cookies, CSRF and tenant binding. The frontend proxies only approved player/public endpoints; master credentials are never sent to it. Local demo balances are not migrated. Native game readiness gates remain enforced; payment gateways still simulate, and bonuses/referrals/leaderboards without backend engines are explicitly unavailable.

Cross-repository QA: `STOREFRONT_PATH=/path/to/Agent-Frontend-Ui AGENCY_BROWSER=true npm run test:agency` launches the real frontend against an isolated backend and verifies signup, persisted profile/deposit, CMS banner publication in mobile 64COR, and support tickets. Without STOREFRONT_PATH, the regular CI still verifies public configuration, tenant isolation and account APIs.
