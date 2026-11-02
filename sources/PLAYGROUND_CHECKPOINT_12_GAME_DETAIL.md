# Playground CP12: Xaxino Game Edit and Game Log Deep Routes
Date: 2026-11-02
Predecessor: CP11 production v0.11.0, deployed to Railway, CI PASS
Scope: connected-user screenshot evidence for Xaxino game/edit/19, users/detail/28928, plus CP11 dashboard link inspection. Browser extension is read-only in Chat mode, and Xaxino tab was not listed during this checkpoint; this document does NOT claim live clicked-page parity.

## Findings verified from Playground source
1. The CP10 UI renders Winning Chance (%) and Win Amount (%) but CP11 gameops_game_profiles lacked these columns, and game detail GET/PUT omitted them. Prior browser tests mocked persistence and missed this production defect.
2. Game Editor's View Game Log navigates to #/game-rounds/:gid, which requested GET /api/admin/deep/games/:gid/rounds, but no route existed. The UI therefore showed Load failed.
3. User Detail Logins and Notifications buttons linked to unrelated admin-wide reports, not specific player histories. No verified game-player login or notification provider exists.
4. Game Log and player rounds endpoints used hardcoded LIMIT 200, without scoped pagination or query filtering.
5. CRITICAL: engine/deep-routes.js used a malformed UUID regex omitting the 4-character variant segment. Valid UUIDs returned HTTP 400 across game detail, player detail and several deep routes. Corrected to canonical 8-4-4-4-12 with version/variant checks, backed by real integration tests.

## Implementation
- Add idempotent PostgreSQL migration for winning_chance and win_amount, NOT NULL default 50 with per-field CHECK 0..100. These values are strictly demo metadata and NOT connected to live engines, game outcomes, or settlement.
- Wire version-guarded PUT and GET readback to both fields; stale updates remain HTTP 409.
- Add game-specific immutable round query GET /api/admin/deep/games/:gid/rounds, and upgrade player-specific GET /api/admin/deep/players/:pid/rounds. Query params page=1..1000, limit=1..100, result=all|win|loss|draw, and q literal substring up to 80 characters.
- SQL bind variables for all user input. Filter by game/player UUID, paginate by event ID descending, return items,total,page,pages,hasNext,filters.
- Derived win/loss/draw uses payout versus stake, NOT Xaxino win_status. The source remains signed observed events only. Added (game_id,id DESC) index.
- Add Game Log shortcut on game list, functional game-specific query/search/result tabs/pager and player-round pager. Missing provider-only user logins/notifications marked disabled, not directed to unrelated admin reports.
- /api/admin/parity notes limited function states and actual blockers.

## Test acceptance
- Real isolated PostgreSQL schema simulates pre-CP12 migration; run ensureSchema twice and verify columns exist.
- GET old fields default to 50, PUT valid fields updates, GET readback matches, version conflict 409, invalid fields 400, and game settlement ledger remains unmodified.
- Game-scoped and player-scoped event histories never leak across games or players; 57 test records paginate without duplicates; filter and literal search work; invalid parameter inputs 400 and missing records 404.
- Playwright browser QA: click games -> Game Log, filter, search, clear, next/back, Game Edit save/refresh, user drilldown, narrow mobile 390px.
- Mandatory: GitHub CI PASS; then squash merge and Railway terminal deployment SUCCESS; verify runtime version and health.

## Explicit remaining gaps
- Actual Xaxino deep subpages cannot be fully clicked through from read-only Chat tab. Existing screenshot evidence only proves those screenshot fields.
- No PII, remote game identity/KYC, user-specific login history, player notifications, or external wallet integration.
- Demo chance / win amount are metadata and never influence external game results.
- Game rounds may be incomplete while no signed round events arrive, even if heartbeat is healthy.
- Unlimited pagination, audit export, and source-level trace correlation remain future work.

Next: CP13 audit user-detail nested buttons and settings deep routes using authorized interactive browser, implement provider integrations separately with clear approval.
