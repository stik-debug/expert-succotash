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
| Required cloud login / signup gate | DONE (untested against live PostgreSQL) |
| Business owner panel (team, roles, devices, activity) | DONE (untested against live PostgreSQL) |
| Platform admin console | DONE (untested against live PostgreSQL) |
| Paystack subscriptions + auto-lock | DONE (untested against live Paystack/PostgreSQL) |
| Daraja direct billing | NOT STARTED |
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


## 3.13 Business Suite update

The Business Suite screen now includes record-backed executive summaries, rule-based business insights, product margin reporting, low-stock review, accounts payable for new credit purchases, payable settlement, branch/staff directories, pricing calculator, loyalty records, sales run-rate estimate, document register, reminders, goals and security guidance. New records are included in snapshot push/pull. See `UPGRADE_3_13.md` for precise boundaries.

Still not complete: normalized branch-level posting, staff authentication/payroll, full bank feeds/reconciliation, OCR, live competitor feeds, production predictive ML, outbound WhatsApp/email, MFA, and managed backup/restore automation. Browser state remains the working copy; optional cloud snapshots are not a managed source-of-truth or backup system.
