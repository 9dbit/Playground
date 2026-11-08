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

The original master production service and main branches remain unchanged. Following the user's additional deployment instruction, the original Mahjong web/worker and Skygate Studio services now expose their Playground export actions. The deployed master controls and package upload remain available independently.

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

## Original Studio production rollout — 8 November 2026

The user authorized this additional rollout after the sandbox milestone. Existing production services were deployed directly from the CI-passing feature commits; no merge to main was performed. Railway source is pinned to these commits, so a subsequent source release must explicitly update the pin. Existing storage/authentication settings were retained and agency mode was not enabled on the original Studio services.

| Service | Commit | Deployment | Result |
|---|---|---|---|
| Mahjong web | `d75ea42af04bbd027fecc64408f7cb52d1d4cfdf` | `5207789c-d951-46bc-83e9-baebd74088bf` | SUCCESS |
| Mahjong worker | `d75ea42af04bbd027fecc64408f7cb52d1d4cfdf` | `ede5e946-fff0-45c5-9ea5-8d336af53bd0` | SUCCESS |
| Skygate web | `701e88fb281c08fced1b89e221cbbe21751e2ebc` | `ae524e93-59f8-42c6-b980-7d35b224ec31` | SUCCESS |

[Mahjong Studio](https://mahjong-legend-web-production.up.railway.app/studio/): the built UI includes **Export Playground** in release history for publishers. The new export endpoint rejects anonymous access. Health confirms PostgreSQL and a ready worker, with the same engine hash as before deployment.

[Skygate Studio](https://skygate-web-production.up.railway.app/studio/): **Preview & Publish → Export paket Playground** is served. Its publisher script matches the tested repository bytes.

No game configuration was published and no player transaction was performed during these deployment checks.

Chromium at 393 px successfully clicked the deployed Skygate export action, downloaded the JSON package, and validated it with the native project validator. Mahjong's production export endpoint remains publisher-authenticated; authenticated export behavior is covered by the passing Studio API CI rather than changing production credentials. A follow-up Skygate fix disables the export button during a pending release request so early clicks cannot be silently ignored; its download/no-publication regression test is included in the 120 passing Node tests.

The final Skygate loading-state fix is deployed as `701e88fb281c08fced1b89e221cbbe21751e2ebc` with terminal SUCCESS. All three checks passed: [general QA](https://github.com/9dbit/Skygate/actions/runs/42466796278), [audio](https://github.com/9dbit/Skygate/actions/runs/42466796276), [iPhone viewport](https://github.com/9dbit/Skygate/actions/runs/42466796312). The agency sandbox remains on its already-verified runtime commit because this follow-up only changes the standalone Studio publisher UI.
