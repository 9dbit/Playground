# Playground 0.9.1 — development access

## Purpose

The project owner requested convenient early-development access without a login form, forced password change, or authenticator enrollment. This release adds a private development link and a distinct development session. The normal owner account remains intact.

## Behavior

- `/development#key=...` removes the fragment before exchanging the 32-byte random key with `/api/auth/development`, then opens `/engine`.
- Only `DEV_ACCESS_KEY_SHA256` is stored in deployment configuration. A valid `DEV_ACCESS_ENABLED=true` and future ISO `DEV_ACCESS_EXPIRES_AT` are also required.
- Development sessions live in `gameops_development_sessions`; tokens are hashed at rest and the cookie remains HttpOnly, Secure in production, and SameSite=Strict.
- Sessions last up to seven days, capped by the configured link deadline. There is no development idle lock; a valid private link can reopen access after logout or expiry.
- Development access uses the distinct `development-admin` audit identity. Operational admin routes retain their existing permission checks, request validation, and CSRF protection.
- `/security` shows development session status and revocation. Password, MFA, recovery, and administrator management require a normally enrolled owner account.
- Disabling the flag, expiring the link, or rotating the key invalidates development sessions after the changed configuration is deployed.
- No real owner password, MFA material, recovery codes, account count, game outcomes, bridge signing keys, or round-ingestion settings are changed.

## Validation

The PostgreSQL suite in `tests/development.integration.test.js` creates an isolated random schema and covers default denial, valid entry, owner isolation, operational CSRF/audit, credential-management boundaries, hashed storage, idle behavior, scoped revocation, logout, restart, rotation, disabling, and expiry. It never points at production.

`tests/development-ui.cjs` uses synthetic mocked API responses to check automatic entry, fragment cleanup, no browser key storage, development labeling, account-management UI isolation, mobile layout, invalid/missing links, logout, and revocation. Existing security and bridge suites remain enabled.

Deployment and actual browser checks must be confirmed against the merged commit and the live service; this source document does not itself assert that a deployment has finished.

## Reverting this access method

Set `DEV_ACCESS_ENABLED=false` on the admin service and deploy that configuration. Existing owner authentication continues to work and existing development sessions are rejected. Keep `SESSION_SECRET` unchanged; it protects owner authenticator material.
