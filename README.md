# Playground GameOps Control Center

Original multi-game administration console inspired by the structure of the Xaxino reference. Node.js 20+, Express and PostgreSQL. Current release: **0.8.0 / Checkpoint 08**.

## Application
- Login: https://playground-admin-production.up.railway.app/login
- Health: https://playground-admin-production.up.railway.app/health
- Security Center: `/security`
- Admin: `/engine`; previous UI: `/engine-v1` (both use current authentication and permissions)

## First login after Checkpoint 08
Existing Checkpoint 07 sessions are invalid. Sign in with the existing owner credential, change the temporary password, and verify an authenticator before entering the dashboard. Save the eight single-use recovery codes privately. Enrollment uses a manual time-based setup key, not a third-party QR service.

The environment username/password only seed the first owner when the account table is empty. Changing environment variables later does not reset that owner's stored password. Never share passwords, setup keys or recovery codes in GitHub or chat.

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

Native TOTP is implemented; OIDC, passkeys, KYC, external notification delivery, wallet/ledger, game adapters, recurring backup verification and job scheduling remain separate milestones. Real-money settlement, user impersonation and live win-rate manipulation are not supported.

## Checkpoints
- `sources/PLAYGROUND_CHECKPOINT_08.md`: security implementation, onboarding, acceptance coverage and remaining work.
- `sources/PLAYGROUND_CHECKPOINT_07.md`: baseline deep-admin features and disconnected integrations.
