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
