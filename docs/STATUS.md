# Status

Legend: DONE | PARTIAL | NOT STARTED

| Area | State |
|---|---|
| Ledger rules (JS) + 15 tests | DONE |
| M-Pesa SMS parser v1 | DONE |
| PostgreSQL schema 001 + 002 | WRITTEN — run `npm run migrate` |
| API server (health, auth, snapshot sync) | DONE (requires DATABASE_URL + pg) |
| Multi-device snapshot push/pull | DONE (API + UI) |
| Modern PWA UI | DONE |
| Professional dashboard + Profit Intelligence | DONE |
| Suppliers, purchases, recurring | DONE |
| Multi-currency display | PARTIAL |
| Smart alerts + quiet hours | DONE |
| AI local + optional cloud key | DONE / PARTIAL |
| Client auth + session timeout | PARTIAL (local) / cloud auth when DB on |
| Daraja billing | NOT STARTED |
| Structured SQL products/sales (beyond snapshot) | PARTIAL (tables exist; app uses snapshot) |
| MFA, automated offsite backups | NOT STARTED |

## Run
```bash
# Local static + API shell
npm start

# With database
export DATABASE_URL=postgres://...
npm install pg
npm run migrate
npm start
```

## Data safety
- Browser localStorage remains the live working copy.
- Cloud snapshot is optional and versioned (optimistic concurrency on revision).
- Posted journal entries stay immutable in SQL.
