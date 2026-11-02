# Playground isolated development UI sandbox

This is a separate static simulator, NOT a production login bypass. It contains the current admin UI plus synthetic browser-only fixtures. No authentication, production database connection, game bridge, credentials, payment, or outbound messaging capability is loaded. The production admin, MFA and users are unchanged.

Open `/` to inspect the UI without login. Form edits are simulated and stored only in this browser tab's sessionStorage. Use **Reset data uji** to restore synthetic fixtures. Do not enter real customer information or credentials. The fixtures have no production authority even though they exercise owner-visible UI controls.

Server: exact file allowlist, GET/HEAD only, no API endpoints, no directory serving or proxy, CSP blocks network connections. Startup refuses production credentials. Deploy ONLY this directory as its own service with no database, mounted volume, secret or game integration. No runtime network request is made by this service.

UI source: 9dbit/Playground main 88c039ea8679bb89b0928296b82e225cb6b022fe (Checkpoint 10). This updated sandbox includes browser-only Functional QA and synthetic internal DEMO_COIN wallet ledger. These NEVER change any production database or external game wallet. Labels are annotated as simulation. Form writes are demonstration state only; this is not evidence of working production workflows.

Run `npm test`, then `npm start` (no npm dependencies). CI separately tests 56 menu/detail paths, local edits, reset and per-browser isolation using Playwright.

PR #5's production development-link access remains unmerged and was NOT activated. This new static application does not include its authentication changes.

Checkpoint 11 update: global search, read/unread activity, profile editing, cron job history and manual-run UI are strictly synthetic browser-tab fixtures. No real cron timer, session cleanup, admin login, outbound traffic or server API is enabled.
