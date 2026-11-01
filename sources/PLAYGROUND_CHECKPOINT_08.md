# Playground GameOps: Checkpoint 08

Date: 2026-11-02. Baseline: main 79235bdeeaa20d38ca2520eaacca32976e1006d1 (Checkpoint 07).
Scope: first native security milestone. No game adapter, balance settlement or external identity provider is activated.

## Shipped implementation

- PostgreSQL admin accounts, roles Owner / Operator / Support / Viewer, active/disabled state.
- Password hashing: asynchronous scrypt N=32768, r=8, p=3, 16-byte random salt. New passwords contain 15 to 128 characters and are never truncated.
- Existing environment credential is used ONLY once to seed the owner account when the account table is empty. Redeploys never reset a DB password.
- First login requires password replacement and TOTP enrollment before any operational admin API can be accessed.
- Native TOTP SHA1, six digits, 30-second period, one step of clock skew; atomic replay prevention.
- Encrypted TOTP enrollment / active secrets (AES-256-GCM with per-account authenticated data and key derived from SESSION_SECRET).
- Eight 128-bit, single-use recovery codes: displayed once, hashes only in the database, consumption under row lock.
- Opaque 256-bit session cookies, token hashes in DB, 8-hour absolute and 30-minute idle limits. All Checkpoint 07 signed cookies cease to work.
- Logout, targeted session revocation, password changes, MFA changes, role changes and account suspension revoke sessions server-side.
- Role allowlist covers both legacy and deep APIs. Unknown admin paths and methods fail closed. Non-owner settings reads return only display-related general values.
- CSRF tokens, same-origin checks, SameSite=Strict and HttpOnly cookies. Secure cookies and HSTS in production.
- Script CSP no longer allows inline scripts. Login script moved to a same-origin asset.
- Persistent per-account / IP authentication throttling. Security mutations require password + fresh MFA when enrolled.
- Security Center UI: password change, authenticator enrollment using a manual key, recovery code display, active session list, owner-controlled admin account creation and access editing.
- Actual request identity is recorded in the shared audit log rather than always using the bootstrap admin name.
- Fixed an observed CP07 missing endpoint: Game Edit -> per-game round list.

## First production login

1. Sign in with the existing owner username and existing credential through /login, not through chat.
2. The service redirects to /security; choose a new password.
3. Start authenticator enrollment, enter the setup key into an authenticator as a time-based account, verify its six-digit code.
4. Save the eight recovery codes offline. Full dashboard access then opens.

The user's authenticator cannot be enrolled on their behalf. MFA is implemented and required, but an account remains un-enrolled until its owner completes verification. The old environment password does not override the new DB password after setup. No password, MFA secret or recovery code is included in this checkpoint.

## Role boundaries

| Role | Access |
|---|---|
| Owner | All explicitly allowed admin operations; manage other administrators with password and MFA reauthentication |
| Operator | Games, profile metadata and content; no request approvals, settings writes or admin/security account management |
| Support | Tickets, internal notification records, subscribers and permitted player reads; no game configuration, settings writes or approvals |
| Viewer | Approved summaries, games, round reads and virtual event reporting; no writes or private user/login/audit records |

Disabling or changing one's own owner role is prohibited. A last active owner cannot be removed through the management flow.

## Test methodology

- New unit suite: password hashing, RFC 6238 SHA1 vectors, replay rejection, authenticated encryption, recovery hashing, role restrictions, deny-default and secret-safe response projections.
- Integration suite: separate random schema on an ephemeral PostgreSQL 18 instance in GitHub Actions. Covers first login, CSRF, password/MFA, recovery replay, all roles, audit identity, session invalidation, restart persistence, idle expiry and persistent throttling.
- Browser suite: desktop / 390px mocked API flow, login/setup UI, recovery acknowledgement and role visibility. Separate CI evidence; it does not claim authenticated production write tests.
- Production verification: deployment terminal state, versioned /health, public login, headers and unauthorized API denial. Never use live user secrets or insert test accounts into production.

## Migration and rollback

Additive tables: gameops_admin_accounts, gameops_admin_sessions, gameops_auth_buckets. Existing operational tables are not dropped or reset. Initialization is serialized with a PostgreSQL advisory transaction lock.

Do NOT roll the application back to Checkpoint 07 after password migration without first taking the app offline; CP07 would restore the obsolete environment-password authentication path. Prefer a forward fix. Back up the database before a future destructive migration.

SESSION_SECRET now protects encrypted authenticator material and recovery hashes. Rotating it without a key-migration plan makes current authenticator secrets unusable. Keep it private and stable; a separate key ring and operator-assisted recovery process remain future hardening work.

## Remaining work

- User completion of mandatory password and MFA enrollment, actual authorized multi-admin onboarding.
- OIDC / enterprise SSO and passkeys are not implemented. This milestone uses native TOTP rather than claiming OIDC is connected.
- Dedicated KMS/key rotation, MFA recovery when ALL recovery codes are lost, password-reset delivery, audit outbox transactions for older business routes, and recurring backup / restore drills.
- Per-game keys, telemetry adapters and engine health handshake in Checkpoint 09.
- Wallet/ledger, KYC, external notifications and scheduler remain disconnected as documented in Checkpoint 07.

## References

- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- TOTP / RFC 6238: https://www.rfc-editor.org/rfc/rfc6238
- Playwright CI setup: https://playwright.dev/docs/ci-intro
