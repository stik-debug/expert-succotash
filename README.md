# MarginPilot

Business management and profit intelligence for SMEs (KES, TZS, UGX, USD, EUR, GBP). Dashboard, product profitability, break-even, cash forecast, suppliers, recurring expenses, grounded AI, and optional cloud sync.

## Layout
- `apps/web` — installable browser app. Working data stays in the browser until you push a cloud snapshot.
- `packages/core` — ledger rules and M-Pesa SMS parser (unit tested).
- `server/` — HTTP API (auth + versioned snapshot sync) when `DATABASE_URL` is set.
- `db/migrations` — PostgreSQL schema (RLS, immutable journals, sessions, snapshots).

## Quick start
```bash
npm start
# open http://localhost:3000
```

## With PostgreSQL (multi-device sync)
```bash
export DATABASE_URL=postgres://user:pass@host:5432/marginpilot
npm install pg
npm run migrate
npm start
```
Open the app: you must sign up or log in. Set `PLATFORM_OWNER_EMAIL=you@domain.com` to make that account the platform admin, then open **Control center**. For quick local use without a database set `ALLOW_LOCAL_MODE=1`.

## Tests
```bash
npm test
# DATABASE_URL=postgres:///marginpilot_test npm run test:db   # needs PostgreSQL 15+
```

## Design rules
- Money is integer minor units. Posted entries are never edited; corrections are reversals.
- Each tenant's rows are isolated by row-level security on `app.tenant_id`.
- MarginPilot never holds users' money. M-Pesa payments are recorded as unverified until matched to a statement.
- Cloud sync stores a versioned JSON snapshot per tenant (optimistic concurrency on revision).

## API
See [docs/API.md](docs/API.md). Health: `GET /api/health`.

## Install
Serve over HTTPS. Android/desktop Chrome and Edge show Install; on iPhone use Safari → Share → Add to Home Screen.
