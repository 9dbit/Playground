# CP14: repair all eight CP13 P1/P2 findings

Baseline: production/main 3e9dad5f010aa830ba4930d1d85cd793c25deb2c (v0.12.0).
Target release: 0.14.0. Scope: F01-F08 only; no claim of full Xaxino feature parity.

## Repairs and compatibility

- F01: remove the legacy server-level per-game round route. The deep router is the sole handler, with validated SQL result filters/search/pagination. Remove stale duplicate System Information route. Full-server tests detect normalized duplicate literal routes.
- F02: explicit field/type/range validation for all 15 configuration forms. Four content-oriented tiles use typed/versioned content APIs; direct settings writes to them are rejected. Unknown keys, negative amounts, percentage >100, invalid timezone/color/URL and string booleans are rejected. Legacy invalid configurations are preserved on startup/read, shown with validation warnings, and corrected only by an explicit valid save.
- F03: every settings PUT requires integer expected_version (0 for absent record). Compare-and-swap updates/first inserts return 409 on conflict or 428 when version missing. UI submits version, preserves unsaved inputs on conflict, and provides explicit reload. Legacy UI points users to the current editor.
- F04: business data plus audit share one SQL transaction/client across game creation/status/config/artwork, player metadata, request review, tickets/messages, notifications, subscribers, content CRUD, settings, own profile and session revocation. Existing transactional wallets/security stay intact. Upload decoding happens outside SQL locks.
- F05: both player list APIs use one validated SQL query builder: filter state before limit, consistent count/items snapshot, stable last_seen/id order, bounded pagination, literal search. User list UI has next/previous pages. Local ban flags still do not affect external engines.
- F06: new ticket message authors come only from authenticated username, ignoring supplied author. Historical messages are retained unchanged; unknown historic authors are not guessed.
- F07: canonical published URLs are /info/page/{slug} and /info/policy/{slug}. Existing same-slug records are preserved. Unique legacy /info/{slug} redirects 308; ambiguous legacy URLs return 409 plus canonical choices. Sitemap has unique typed URLs using configured public origin, excludes drafts, honors disabled flag. CMS lists show the public link. Startup counts legacy collisions without deleting or renaming content.
- F08: sharp performs bounded full decode, validates MIME/dimensions/pages, re-encodes to WebP and strips metadata. Input <=500KB, dimensions <=4096 each, <=16MP, single frame; output <=500KB and <=1600px. Truncated signature-only images, mismatched MIME, malformed encoding and oversized input rejected. Max two concurrent decodes; five-second processing timeout.

## Verification contract

Run npm test and tests/cp14-server.cjs against an isolated localhost PostgreSQL gameops_ci schema. The latter boots real server.js, exercises auth/CSRF/RBAC/mount order and injects audit failures. It seeds synthetic sessions only in the disposable schema. CP14_BROWSER=true enables real HTTP Playwright tests of stale-form handling, user paging, author rendering, canonical links and mobile layout. No production writes or secrets are used.

Full-server regression includes original bug reproductions with corrected expectations, concurrent settings writers, first-write collision, sixteen rollback paths, pre-existing page/policy collision, restart, actual image decoder and unchanged wallet idempotency.

Release gate: all CI jobs PASS, review exact branch diff, squash-merge and verify Railway terminal SUCCESS plus health version 0.14.0. A code change alone is not evidence of deployment. Final CI/deploy evidence is attached to the release PR.

## Retained boundaries

The observational bridge remains separate from legacy game-event counters. No rounding/reconciliation, KYC provider, OAuth, external notification delivery, bonus execution, real-money settlement, player impersonation or live outcome controls were added. Unverified source features remain Partial/Blocked. Passwords/MFA and bridge keys are unchanged; sandbox remains isolated.

Image-validation reference: https://sharp.pixelplumbing.com/api-constructor/ (failOn, limitInputPixels). Only buffers are decoded; URL/file-path input is not accepted.
