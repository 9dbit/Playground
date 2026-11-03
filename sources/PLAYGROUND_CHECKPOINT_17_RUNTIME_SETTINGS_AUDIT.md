# Playground CP17 Pre-Implementation Audit: Effective Runtime Settings

Date: 2026-11-03. Source baseline: admin main 9bbf6957f1296f9d417de293ee843d290bd147b8. This is a source-backed audit, **not a CP17 production release**.

## Objective
Do not mistake persisted settings JSON for effective runtime behavior. Improve concrete consumers and label provider-gated features honestly. Preserve CP14 versioned settings CAS, audit transactions and CP16 source wallet/owner MFA.

## Confirmed source inventory
There are 19 Settings cards in public/control.js. Fifteen use typed schemas in engine/settings-schema.js: general, logo, configuration, notification, seo, kyc, social, language, extensions, cron, maintenance, gdpr, css, sitemap, robots. Four are versioned content modules: templates, pages, frontend, policies.

Current status based on code:
- **Runtime consumers already present**: public maintenance on informational pages, sitemap.xml from published content, robots.txt config rules, a narrowly scoped local expired-session cleanup cron scheduler with run-history (engine/admin-operations.js:runMaintenance/startScheduler), some general site colors/title. The control.js UI labels cron as 'No scheduler' and parity.js describes it blocked; that label is stale. It is NOT a vendor cron or remote-game scheduler.
- **Partly applied**: general timezone/currency/page limit format, content page/policy rendering, user-facing branding, SEO metadata, template/frontend content slots, language translation.
- **Stored/configuration-only, provider not connected**: notification email delivery, KYC, social OAuth, extension executor, GDPR consent processing, external games' bonus/transfer rules. Do not silently execute an admin toggled provider feature without an integration; do not falsely mark user verified.
- **Safety-protected**: custom CSS draft is deliberately not executed as arbitrary untrusted markup; the UI must say it is a draft, not pretend active.

## P1 CP17 implementation order
1. Add a **settings capabilities/health endpoint** derived from actual consumers, read-only for authorized roles: module status (effective, limited, saved_only, unavailable), owner-configured version, external dependency and effective scope. Do not conflate enabled with operational.
2. Fix scheduler UI/parity source discrepancy: local session cleanup is actually functional; show enabled, last run, interval and history from /api/admin/ops/cron, while correctly saying external vendors/game cron are unavailable. Ensure owner-only manual run and audit remain intact.
3. Apply safe user-facing general/branding/SEO on supported public informational pages with sanitization, cache/ETag invalidation and role boundaries. Track exact consumer in tests; never use admin-provided URLs/CSS as trusted HTML/JS.
4. Honor safe formatting preferences (timezone, currency label, per-page) in specified admin lists, without changing stored numeric amounts or nominal ledger amounts. Explicitly scope each consumer.
5. Keep register/gameplay bonus and transfer fee controls marked **inactive** until a source-authoritative virtual wallet consumer is present. No automatic bonus execution or unsourced balance mutation.
6. Local notification settings can affect only audited local notification UI; external email/SMS/push settings must remain blocked pending provider connection.
7. Finish governance of locale, GDPR consent, security settings only with documented public visitor state and revocation. KYC/OAuth/providers require credentials, consent and verification pipeline.

## Acceptance contract
- Actual server + disposable PostgreSQL + real browser tests; no mocks for claimed end-to-end modules.
- Saving settings via expected_version CAS must produce an observable effect at a supported runtime route, or a visible 'not connected' status with reason.
- Concurrent owners editing a module get 409 conflict; unsaved fields survive UI reload.
- No external game modifications, fake KYC, unsupported OAuth, arbitrary JS/CSS execution, payment service or notification delivery claims.
- CP14 (26), CP15 (8), CP16 (8) acceptance suites and all current unit tests remain green.
- Final release requires exact branch-head CI, review, merge, Railway SUCCESS and postdeploy smoke.

## Boundary
This report does not claim CP17 work is built or deployed. Remaining CP18 external communications/identity and CP19 deepest Xaxino parity depend on actual provider connections and audited source features.
