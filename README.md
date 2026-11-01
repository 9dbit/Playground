# Playground GameOps Engine

Standalone multi-game administrative control center for Skygate 5000, UNO LUCK and Mahjong Wild.

## Architecture
Node 20+ / Express / PostgreSQL, authenticated admin APIs, signed game event ingestion, audit logging, and a responsive original UI. This project is **not** connected to the three game engines yet. Seeded game rows are catalog placeholders; all live telemetry begins at zero. Balances and approvals are not settled. No payment processor exists.

## Start
`npm install` → configure environment variables from `.env.example` → `npm start`.

API: `/health`, `/api/auth/session`, `/api/admin/{summary,games,players,rounds,settings,requests,tickets,audit,system}`, `POST /api/v1/game-events`.

## Railway
Provision a Railway PostgreSQL service in the same project and supply `DATABASE_URL=${{Postgres.DATABASE_URL}}`. Generate strong separate secret values for ADMIN_PASSWORD, SESSION_SECRET and GAME_EVENT_SECRET. Never commit them. Set NODE_ENV=production. Default web port comes from PORT. Railway healthcheck /health requires a live database.

## Security / limitations
Initial admin is a single environment-supplied credential. Before adding actual player identities, cash-equivalent funds, KYC, or additional operators, implement a proper identity provider and MFA, granular RBAC, CSRF rotation, IP protection, tenant isolation, signed game secrets per integration, backups and recovery, deployment observability, and automated tests. Do not use this starter for regulated gaming or payments.

## Progress
See `sources/PLAYGROUND_CHECKPOINT_04.md`.
