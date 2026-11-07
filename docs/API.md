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
