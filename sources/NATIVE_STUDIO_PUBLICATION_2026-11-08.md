# Native Studio publication — 8 November 2026

## Operator workflow

Open **Menu utama → Manage Games → Rilis Studio** (`/native-studio`) in the isolated Playground master sandbox. Choose Mahjong Wild or Skygate 5000. The panel has the shared back/menu controls and the configured Chatvice support widget.

1. Edit the supported animation/audio controls, or upload a complete `playground.studio.v1` JSON package exported from the game's Studio.
2. Saving only stages an immutable package. The native runtime validates its configuration and bundled media and returns a signed validation receipt.
3. Master owner explicitly publishes a validated package using the current account password and MFA/recovery verification when enabled. A reason and current generation are required. Agent credentials cannot use these endpoints.
4. The page distinguishes requested and confirmed releases. “Sudah diterapkan” requires the matching runtime receipt, a recent connection and no reported error.
5. A previous validated package or the bundled configuration can be selected for rollback with the same verification. Old published media remains available for existing rounds.

The first Skygate package uses the Studio template layout, retaining the bundled engine's math and starting stake. The edit dialog calls out the layout change. No configuration is automatically published when the sync worker starts.

## Contract and durability

- Sandbox-only, bound to the catalog game by the existing signed native key. `studio-sync` cannot be used to select another game's target.
- Central database holds immutable package bytes and SHA-256, generation, desired version, validation and applied receipts. Passwords, recovery secrets and player wallet data are not part of a package.
- Native package/media storage uses the existing persistent volume. SQLite uses WAL/FULL durability; release/media writes complete before an applied acknowledgement.
- Mahjong checks the engine hash and full config schema; UUID media references resolve only to validated bundled bytes. No supplied remote media URL is fetched. Unpublished media is private.
- Skygate reuses Studio's project/media validation and immutable release store. The browser refuses a fresh spin after detecting a page/config version change and requests reload. Existing accepted outcomes remain immutable and retryable.
- A new release affects new work; an already issued Mahjong ticket and accepted native rounds keep their pinned configuration. Publication/rollback never credits, debits or moves player balances.
- Limits: 34 MB package, 24 MB custom media, 24 versions and 350 MB central package archive per game. Archive exhaustion returns an actionable error and requires backup/maintenance; this change does not silently delete history.

## Local validation

- Playground: 62 unit checks pass; five tests requiring native PostgreSQL are skipped locally.
- Full agency integration: **41 pass, 0 fail**, including actual mobile 64COR → Mahjong/Skygate launch, master UI staging/validation/publication, wrong password/stale generation/invalid package rejection, runtime restart, old-round retry, rollback, return navigation and matching wallet balances. Exactly one settlement journal per round and zero reconciliation differences.
- Skygate: 119 Node tests pass, including durable Studio apply/restart/rollback and checksum/invalid package rejection.
- Mahjong: four focused native/Studio tests pass (plus the existing engine coverage from the earlier milestone); fourteen Django Studio API tests pass, including publisher-only package export. Studio UI production build passes.
- Mobile publication panel is inspected at 393 px; release actions stack vertically rather than requiring horizontal scrolling.

Tests use disposable synthetic-credit databases. Published evidence contains no test accounts, credentials, tokens, device identities or raw session logs.

## Deployment and remaining boundaries

Enable `AGENCY_STUDIO_SYNC=1` only on the existing Mahjong and Skygate agency sandbox services after the backend has this route. Keep persistent volumes and one replica. The worker contacts Playground over the existing authenticated native transport. Health reports expose only sync enabled/time/error metadata.

The original master/Studio production services and main branches are not changed. Source Studio export buttons are included in the native feature PRs; the original Studio production deployments require their own release. The deployed master panel's built-in controls and package upload are usable independently of those export buttons.

This is not live wagering/RTP certification. Native PostgreSQL load certification and real payment/email/SMS/KYC/OAuth provider setup remain separate from this sandbox publication path.

## Deployed source verification

| Service | Source commit | Terminal Railway deployment |
|---|---|---|
| Playground agent sandbox | `e5edab1aa16246efc1db3961f9f59912af8a9f2a` | `5e6df3d6-051d-4749-a54d-d67871684a7d` — SUCCESS |
| Mahjong agency sandbox | `d75ea42af04bbd027fecc64408f7cb52d1d4cfdf` | `45833cac-27bf-478c-a912-db0b64854b74` — SUCCESS |
| Skygate agency sandbox | `e323b3b8ae8cf963f3f4ee0caa5a9f3445f2d9fa` | `aec5f74e-3a45-4014-8b45-6c7e5a914ddd` — SUCCESS |

Both native health endpoints confirm Studio sync enabled, a recent successful sync and no error. The master page redirects anonymous users to login; its new script is served successfully. A transient Railway dependency-download 504 during the catalog update was recovered by redeployment.

Local integration evidence: [native-studio-local-2026-11-08.json](evidence/native-studio-local-2026-11-08.json).

Deployed zero-coin smoke also passes: 64COR registration → launch → native redeem → context/state for both games, catalog release SHA equals the running source, balance/reserved remain zero, and the canonical return address is 64COR. The existing UNO launch/key still works. No paid rounds or funds transfers were performed on deployed services. Evidence: [native-studio-deployed-2026-11-08.json](evidence/native-studio-deployed-2026-11-08.json).

CI records: [Mahjong engine/browser/Studio](https://github.com/9dbit/Mahjong-legend/actions/runs/42464368122), [Skygate QA](https://github.com/9dbit/Skygate/actions/runs/42464378241), [Skygate audio](https://github.com/9dbit/Skygate/actions/runs/42464378279), [Skygate iPhone viewport](https://github.com/9dbit/Skygate/actions/runs/42464378212).
