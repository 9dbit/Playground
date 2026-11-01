# Playground · GameOps Control Center

Original multi-game administration console inspired by the **structure** of the Xaxino reference. Built on Node.js 20+, Express, and PostgreSQL.

## Live application
- Login: https://playground-admin-production.up.railway.app/login
- Health: https://playground-admin-production.up.railway.app/health
- Admin: /engine (authentication required)
- Previous UI: /engine-v1 (retained for rollback)

## Features
- Deep sidebar navigation and 19 modules in System Settings
- Games -> versioned Game Edit, artwork and per-game immutable event logs
- Players -> User Detail, profile metadata, per-user rounds and event details
- Ticket threads, virtual request review, admin login audit and notification records
- Four report views (transfers intentionally unavailable), subscribers and basic content CMS
- Public informational content, robots.txt, sitemap.xml and scoped maintenance mode
- Signed inbound DEMO_COIN events; **no external game integration yet**

## Local development
Configure from `.env.example` and set required variables. Start a PostgreSQL instance, then:

```bash
npm install
npm test
npm start
```

Database tables are created using additive, idempotent SQL on app startup.

## Security
Never copy secrets into GitHub or chat. The original single-admin login still requires credential rotation and MFA/RBAC for sensitive data.
Logout revokes signed session nonces for API requests. Write actions retain CSRF validation.
Real-money settlement, impersonation, live win-rate adjustment and external account verification are intentionally not supported.

## Change log
Read `sources/PLAYGROUND_CHECKPOINT_07.md`, which lists delivered features and remaining integration work.
