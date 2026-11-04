# Status

Legend: DONE | PARTIAL | NOT STARTED

| Area | State |
|---|---|
| Ledger rules (JS) + 15 tests | DONE |
| M-Pesa SMS parser v1 | DONE (synthetic fixtures; real formats still needed) |
| PostgreSQL schema + integrity tests | WRITTEN, not run |
| Modern PWA UI (mobile nav, sidebar, command palette, dark mode) | DONE |
| Home briefing, charts, alerts, period switch | DONE |
| Sell: tiles, keypad, barcode, discount, split, credit, receipts | DONE |
| Stock + quantity adjust | DONE |
| Money: M-Pesa match, sales history, refunds, trial balance, expenses, period lock | DONE |
| Customers + credit payment | DONE |
| Reports (P&L snapshot, cash position, margins) | DONE |
| **AI Assistant (local)** — answers from real records with citations | DONE |
| **AI Assistant (cloud)** — optional xAI/OpenAI key in Settings | PARTIAL — works when user pastes key; no server proxy |
| Roles UI locks | PARTIAL — demo switch; no server auth |
| Offline shell + queue badge | DONE |
| Plans in KES | DONE (browser only) |
| API server, Daraja billing, multi-device sync | NOT STARTED |

## Credentials needed for full platform
- Safaricom Daraja production (subscription Paybill/Till)
- Hosted PostgreSQL
- SMS/WhatsApp provider
- Optional: xAI or OpenAI API key (user can paste in AI settings for cloud answers)
- Apple/Google developer accounts for store apps

## Deploy
`npm start` serves `apps/web` on `PORT` (Render-compatible).
