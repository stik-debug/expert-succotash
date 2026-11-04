# Status

Legend: DONE and tested | WRITTEN, not yet run | NOT STARTED

| Area | State |
|---|---|
| Ledger rules in JS (balance, integers, immutability, reversal, period lock, reopen) | DONE, 12 tests pass (`npm test`) |
| M-Pesa SMS parser v1 | DONE against SYNTHETIC fixtures; real formats still needed |
| PostgreSQL schema, RLS, immutability triggers, balance trigger, period lock, plans, subscriptions | WRITTEN, not yet run (needs PostgreSQL) |
| DB integrity tests (`db/tests/001_core_test.sql`) | WRITTEN, not yet run |
| Browser demo (`apps/web/index.html`): POS, M-Pesa paste + statement matching, dashboard | WORKING, browser-local storage only |
| API server (auth, MFA, endpoints) | NOT STARTED |
| Web app on the API, mobile apps, offline sync queue | NOT STARTED |
| Invoicing, customers, suppliers, purchasing, reports | NOT STARTED |
| Roles and approvals in the app | NOT STARTED (roles exist in the schema) |
| Business Doctor, Profit Leak Detector, Simulator | NOT STARTED |
| Multi-branch, industry modules | NOT STARTED |
| Subscription billing, M-Pesa subscription payments, Super Admin | NOT STARTED (tables exist) |

## Credentials and approvals you will need
- A Paybill or Till for MarginPilot subscription revenue, and Safaricom Daraja production approval for it.
- Hosting account with managed PostgreSQL and backups.
- SMS/WhatsApp provider, email provider, push credentials (Expo/FCM/APNs).
- Apple Developer and Google Play accounts for the mobile apps.
- KRA/eTIMS access if you want tax integration.
