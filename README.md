# MarginPilot

Business management and financial intelligence for Kenyan SMEs. This repository is an early foundation, not the finished platform. See `docs/STATUS.md` for exactly what works.

## Layout
- `apps/web/index.html` single-file browser demo (open it directly; data stays in your browser).
- `packages/core` ledger rules and M-Pesa SMS parser, with tests.
- `db/migrations` PostgreSQL schema with row-level security and integrity triggers.
- `db/tests` SQL integrity tests.

## Run
```
npm test                                  # JS tests, no install needed (Node 20+)
createdb marginpilot_test
DATABASE_URL=postgres:///marginpilot_test npm run test:db   # needs PostgreSQL 15+; use an empty database
```

## Design rules
- Money is integer minor units. Posted entries are never edited; corrections are reversals.
- Each tenant's rows are isolated by row-level security on `app.tenant_id`.
- MarginPilot never holds users' money. M-Pesa payments are recorded as unverified until matched to a statement.
- A pasted SMS is evidence, not proof.
