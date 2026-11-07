# MarginPilot 3.13 — Business Suite foundation

This release adds an integrated Business Suite screen to the existing application. Existing local records are retained; new records are stored in the existing business snapshot and included in cloud snapshot push/pull.

## Added in this release

- Business Suite executive summary based on recorded ledger and sales data.
- Business Doctor rule-based insights with explicit source-data limitations.
- Product profitability table using recorded sales quantities, current unit costs and prices.
- Low-stock review list.
- Accounts Payable ledger account for new credit purchases; supplier payments can be recorded against the aggregate payable balance.
- Branch directory records.
- Staff directory records (not login provisioning or payroll).
- Gross-margin pricing calculator.
- Customer loyalty notes and points records.
- 30-day sales run-rate estimate clearly labelled as an estimate.
- Industry type display and links back to existing business-specific setup.
- Document register for invoice/receipt references (not OCR or automatic posting).
- Operational reminder register (not email/WhatsApp delivery).
- Business goal register.
- Executive view of recorded revenue, gross profit, expenses and cash.
- New Business Suite data included in cloud snapshot serialization and hydration.

## Accounting correction

New purchases recorded on credit now debit Inventory and credit Accounts Payable. The Business Suite can record a payment against the aggregate Accounts Payable balance. Historical journal entries are not rewritten automatically; review and correct legacy entries through an approved, auditable reversal/adjustment process.

## Important production limitations

This release does **not** claim that the following are fully implemented: normalized branch-level accounting, staff authentication/payroll/attendance, full financial statements and bank feeds, live competitor pricing, predictive ML forecasting, automated OCR, WhatsApp/email delivery, MFA, managed offsite backups, automatic disaster recovery, or production-grade cloud database source-of-truth enforcement.

The existing app continues to use its browser state as its working copy and optional versioned cloud snapshots. Cloud snapshots are not a substitute for managed database backups. Configure PostgreSQL, run migrations, verify backup/restore, and test on a staging tenant before production deployment.

## Verification

- `node --check apps/web/app.js`
- `npm test` — 15 existing tests pass.
- ZIP integrity and local server smoke test should be completed before deployment.
