# Panel navigation — 8 November 2026

Scope: shared dashboard navigation and role-aware routing only.

- Shared pill controls show Menu utama and a stable parent destination, independent of external browser history.
- Master agent detail returns to Semua agen, then Dashboard master. Agent navigation stays in its own workspace.
- The context line identifies the panel, selected agent and page. The browser title and aria-current identify the active page.
- Selecting or defaulting an agent persists tenant_id in the URL. Deep links, reloads and tenant changes preserve the selected section.
- Unknown or unauthorized section hashes resolve to an accessible section. Authentication and backend authorization remain unchanged.
- On mobile the horizontal strip is replaced by the existing dialog menu only after shared navigation initializes. The dialog follows the sidebar permission inventory, closes on selection/Escape and restores keyboard focus.
- The shared master inventory is no longer mutated on menu opening. Empty deferred-only groups are omitted; existing deferred entries remain labeled as unfinished.

## Validation

`npm test`: 62 passed, 5 skipped, 0 failed. Skips require native PostgreSQL integration setup.

`node tests/panel-navigation-ui.cjs`: passed at widths 1440, 393 and 320 px. The test loads actual UI assets with synthetic read-only API fixtures and checks role-scoped menus, tenant selection, context persistence, trailing slash, invalid route fallback, menu reopening, current-page markers, Escape/focus, parent destinations, login screen isolation and horizontal overflow. This browser check is included in the existing browser CI job.

This verifies dashboard navigation, not all business operations or a logged-in production session. No account credentials or transaction records were modified.
