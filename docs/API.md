# MarginPilot API

Base URL: same origin as the web app (e.g. `https://your-host/api`).

When `DATABASE_URL` is not set, only `GET /api/health` works; other routes return `503 database_unavailable`. The browser app continues to work fully offline.

## Health

`GET /api/health`

```json
{ "ok": true, "service": "marginpilot", "version": "3.8.0", "db": true, "time": "..." }
```

## Auth

### Register
`POST /api/auth/register`

```json
{ "email": "owner@example.com", "password": "min8chars", "businessName": "My Shop", "currency": "KES", "country": "KE" }
```

Returns `201` with `token`, `user`, `tenant`, `role`.

### Login
`POST /api/auth/login`

```json
{ "email": "owner@example.com", "password": "..." }
```

### Me
`GET /api/auth/me`  
Header: `Authorization: Bearer <token>`

### Logout
`POST /api/auth/logout`  
Header: `Authorization: Bearer <token>`

## Snapshot sync (local-first)

The browser remains the working store. Cloud holds a versioned JSON snapshot per tenant for multi-device recovery.

### Status
`GET /api/sync/status` → `{ tenantId, revision, checksum, updatedAt }`

### Pull
`GET /api/sync/snapshot` → `{ revision, checksum, updatedAt, payload }`

### Push
`PUT /api/sync/snapshot`

```json
{ "baseRevision": 3, "payload": { /* local S state */ } }
```

- First push: `baseRevision` `0` creates revision `1`.
- Later pushes must send the current revision as `baseRevision` or the server returns `409 revision_conflict`.

## Migrations

```bash
export DATABASE_URL=postgres://user:pass@host:5432/marginpilot
npm install pg
npm run migrate
npm start
```

## Security notes

- Passwords: scrypt with per-user salt.
- Session tokens: random 32 bytes, stored as SHA-256 hash only.
- Tenant isolation: PostgreSQL RLS via `app.tenant_id` for snapshot access.
- Posted journal rows remain immutable in SQL (reversals only).


## Password reset (email)

### Request link
`POST /api/auth/forgot-password`

```json
{ "email": "owner@example.com", "origin": "https://your-app.example" }
```

Always returns a generic success message (no email enumeration). Requires migration `003_password_reset.sql`.

### Complete reset
`POST /api/auth/reset-password`

```json
{ "token": "from-email-link", "password": "new-password-min-8" }
```

### Email delivery
Set either:

```bash
RESEND_API_KEY=re_...
EMAIL_FROM="MarginPilot <noreply@yourdomain.com>"
```

or SMTP (TLS port 465):

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=noreply@yourdomain.com
```

Without email config, the reset URL is printed in the server log (`[email:dev]`).


## Control center (v3.10)

All routes need `Authorization: Bearer <token>`.

### Accounts
- `POST /api/auth/register` — creates the business and its owner in one transaction. Returns `isPlatformAdmin`.
- `POST /api/auth/login` — rate-limited (6 failures / 10 min per IP+email); suspended users/businesses get `403`.
- `POST /api/auth/change-password` `{ currentPassword, password }` — signs out other devices.

### Business owner (`role = owner` only) — `/api/owner/*`
- `GET  /api/owner/overview` — business, cloud-data status, members, active sessions, recent security events
- `PUT  /api/owner/business` `{ name, currency, country }`
- `POST /api/owner/members` `{ email, password, role }` — `administrator | branch_manager | accountant | cashier | stock_manager | salesperson`
- `PUT  /api/owner/members/:userId` `{ role?, password?, status? }` (`status`: `active | suspended`)
- `DELETE /api/owner/members/:userId`
- `DELETE /api/owner/sessions/:id`, `POST /api/owner/sessions/revoke-others`

### Platform admin (`users.is_platform_admin`) — `/api/admin/*`
- `GET /api/admin/overview` — counts and recent events
- `GET /api/admin/tenants?q=` · `PUT /api/admin/tenants/:id` `{ status?, plan? }`
- `GET /api/admin/users?q=` · `PUT /api/admin/users/:id` `{ status?, revokeSessions? }`

Admins see account/usage metadata only, never business records.

### Configuration
```bash
PLATFORM_OWNER_EMAIL=you@yourdomain.com   # this email becomes platform admin on signup/login
ALLOW_LOCAL_MODE=1                        # dev only: skip the login gate (no database needed)
```
Run `npm run migrate` to apply `004_control_center.sql`.
