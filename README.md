# MarginPilot

Business management and financial intelligence for Kenyan SMEs.

## Layout
- `apps/web` — installable browser app (open `index.html` or serve the folder). Data stays in the browser.
- `packages/core` — ledger rules and M-Pesa SMS parser, with tests.
- `db/migrations` — PostgreSQL schema with row-level security and integrity triggers.
- `db/tests` — SQL integrity tests.
- `docs/STATUS.md` — what works and what is not connected yet.

## Run
```
npm test                                  # JS tests, no install needed (Node 20+)
createdb marginpilot_test
DATABASE_URL=postgres:///marginpilot_test npm run test:db   # needs PostgreSQL 15+; use an empty database
```

Open the UI:
```
# any static server, e.g.
npx --yes serve apps/web
# or open apps/web/index.html directly
```

## Design rules
- Money is integer minor units. Posted entries are never edited; corrections are reversals.
- Each tenant's rows are isolated by row-level security on `app.tenant_id`.
- MarginPilot never holds users' money. M-Pesa payments are recorded as unverified until matched to a statement.
- A pasted SMS is evidence, not proof.
