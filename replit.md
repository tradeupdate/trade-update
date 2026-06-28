# TradeUpdate — V75 Algorithmic Trading Bot

Institutional-grade algorithmic trading platform for the Deriv Volatility 75 (V75) Index. Features a multi-layered scoring engine, automated bot execution, deterministic backtesting, and an admin dashboard for user and strategy management.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the API server (port 8080)
- `pnpm --filter @workspace/tradeupdate run dev` — run the frontend (port 5000)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run seed` — seed DB with admin user, strategies, profiles
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Seeded Logins

- **Admin**: `admin` / `Admin1234!`
- **User**: `Clean10test` / `Test1234!`

## Stack

- pnpm workspaces monorepo, Node.js 20, TypeScript 5.9
- **Backend**: Express 5, port 8080
- **Frontend**: React 19, Vite, Tailwind CSS 4, Wouter, TanStack Query — port 5000
- **DB**: PostgreSQL (Replit managed) + Drizzle ORM
- **Real-time**: WebSocket (Deriv API) + SSE (bot status to frontend)
- **Auth**: Custom JWT (cookie-based, 8h expiry)
- **Validation**: Zod, drizzle-zod
- **Charts**: lightweight-charts (TradingView), Recharts

## Environment Variables

Set in `.replit` `[userenv.shared]` (auto-loaded):
- `PORT=8080` — backend server port
- `JWT_SECRET` — signs auth tokens
- `ENCRYPTION_KEY` — used for encrypting Deriv API tokens at rest

Provisioned as Replit secrets (auto-set):
- `DATABASE_URL` — PostgreSQL connection string

Optional (email features disabled if not set — falls back to local outbox file):
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `APP_URL` — used in approval emails (defaults to `https://tradeupdate.app`)

## Where Things Live

- `artifacts/api-server/src/index.ts` — Express server entry
- `artifacts/api-server/src/services/bot.ts` — trading bot loop
- `artifacts/api-server/src/services/scoring.ts` — 7-layer institutional scoring engine
- `artifacts/api-server/src/services/deriv.ts` — Deriv WebSocket connection (wss://ws.binaryws.com)
- `artifacts/api-server/src/services/backtest-engine.ts` — deterministic backtester
- `artifacts/api-server/src/middleware/auth.ts` — JWT create/verify
- `artifacts/tradeupdate/src/` — React frontend
- `lib/db/src/schema/` — Drizzle schema (users, trades, signals, strategies, system)
- `scripts/post-merge.sh` — runs on merge: pnpm install → db push → seed

## Architecture Decisions

- Backend and frontend are separate processes on different ports; Vite proxies API calls in dev
- Deriv WebSocket connects at startup with exponential backoff (no env var needed — uses public app_id 1089)
- Email is gracefully optional — if SMTP_HOST is unset, emails are saved to `email-outbox.json`
- JWT is stored in an httpOnly cookie (not localStorage) for XSS resistance
- Scoring engine tracks indicator accuracy and adjusts weights dynamically (Adaptive Intelligence)

## User Preferences

- Seeded logins are working well (user and admin)
