# Playground isolated development UI sandbox

This is a separate static simulator, NOT a production login bypass. It contains the current admin UI plus synthetic browser-only fixtures. No authentication, production database connection, game bridge, credentials, payment, or outbound messaging capability is loaded. The production admin, MFA and users are unchanged.

Open `/` to inspect the UI without login. Form edits are simulated and stored only in this browser tab's sessionStorage. Use **Reset data uji** to restore synthetic fixtures. Do not enter real customer information or credentials. The fixtures have no production authority even though they exercise owner-visible UI controls.

Server: exact file allowlist, GET/HEAD only, no API endpoints, no directory serving or proxy, CSP blocks network connections. Startup refuses production credentials. Deploy ONLY this directory as its own service with no database, mounted volume, secret or game integration. No runtime network request is made by this service.

UI source: 9dbit/Playground main ff240a1fd9d9580c3b20bbffed90c47e64ed49c6. Labels are annotated as simulation. Form writes are demonstration state only; this is not evidence of working production workflows.

Run `npm test`, then `npm start` (no npm dependencies). CI separately tests 56 menu/detail paths, local edits, reset and per-browser isolation using Playwright.

PR #5's production development-link access remains unmerged and was NOT activated. This new static application does not include its authentication changes.
