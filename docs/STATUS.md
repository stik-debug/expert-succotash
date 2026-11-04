# Status

Legend: DONE and tested | WRITTEN, not yet run | NOT STARTED | PARTIAL (UI / local only)

| Area | State |
|---|---|
| Ledger rules in JS (balance, integers, immutability, reversal, period lock, reopen) | DONE, 15 tests pass (`npm test`) |
| M-Pesa SMS parser v1 | DONE against SYNTHETIC fixtures; real formats still needed |
| PostgreSQL schema, RLS, immutability triggers, balance trigger, period lock, plans, subscriptions | WRITTEN, not yet run (needs PostgreSQL) |
| DB integrity tests (`db/tests/001_core_test.sql`) | WRITTEN, not yet run |
| Browser app (`apps/web`): POS, M-Pesa paste + statement matching, dashboard, stock, journal | DONE — upgraded mobile-first UI, localStorage only |
| Design system (emerald/gold, dark mode toggle, type scale, a11y focus/targets) | DONE |
| Mobile bottom nav + FAB; desktop sidebar; command menu (Ctrl/Cmd+K) | DONE |
| Home briefing, period switch, sales chart, top products, attention alerts | DONE |
| Faster selling: product tiles, custom keypad, barcode (BarcodeDetector), discount, split, credit, receipts | DONE |
| PWA (manifest, icon, service worker offline shell, sync badge / offline queue) | DONE |
| Staff roles (owner/manager/cashier/stock/accountant) UI locks | PARTIAL — demo role switch; no server auth/PIN/biometrics |
| Posted records immutable; reverse with reason; period lock | DONE (browser + core) |
| Business Doctor (from local records), what-if simulator | DONE (local data only) |
| Plans in KES, editable prices, no hidden fees messaging | DONE (browser storage) |
| API server (auth, MFA, endpoints) | NOT STARTED |
| Offline sync to server | NOT STARTED (queue exists locally; no backend) |
| Invoicing, suppliers, purchasing, multi-branch | NOT STARTED |
| Subscription billing via M-Pesa Daraja, Super Admin | NOT STARTED (tables exist in schema) |
| Real M-Pesa SMS format fixtures | NOT STARTED |

## Credentials and approvals you will need
- A Paybill or Till for MarginPilot subscription revenue, and Safaricom Daraja production approval for it.
- Hosting account with managed PostgreSQL and backups.
- SMS/WhatsApp provider, email provider, push credentials (Expo/FCM/APNs).
- Apple Developer and Google Play accounts for the mobile apps.
- KRA/eTIMS access if you want tax integration.

## How to open the app
Open `apps/web/index.html` in a modern browser (or serve the `apps/web` folder). Data stays in `localStorage` under key `marginpilot.v1` — existing demo data is preserved across this upgrade.
