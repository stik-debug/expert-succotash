/**
 * PostgreSQL access for MarginPilot API.
 * When DATABASE_URL is unset, db.enabled is false and the API runs in local-static mode.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

let pool = null;
export const db = {
  enabled: false,
  pending: [],
  async migrate() {
    const client = await pool.connect();
    try {
      await client.query('select pg_advisory_lock(727001)'); // one instance migrates at a time
      await client.query(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
      const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
      const done = new Set((await client.query('select id from schema_migrations')).rows.map((r) => r.id));
      // Adopt databases built by hand so the non-repeatable baseline files are never re-run.
      const probe = { '001_core.sql': 'tenants', '002_sync_and_sessions.sql': 'sessions', '003_password_reset.sql': 'password_reset_tokens' };
      for (const [f, t] of Object.entries(probe)) {
        if (done.has(f)) continue;
        const r = await client.query('select to_regclass($1) as x', ['public.' + t]);
        if (r.rows[0].x) { await client.query('insert into schema_migrations (id) values ($1) on conflict do nothing', [f]); done.add(f); }
      }
      for (const f of files) {
        if (done.has(f)) continue;
        console.log('[db] applying', f);
        try {
          await client.query('begin');
          await client.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
          await client.query('insert into schema_migrations (id) values ($1)', [f]);
          await client.query('commit');
          done.add(f);
        } catch (e) {
          try { await client.query('rollback'); } catch (_) {}
          console.error('[db] migration FAILED', f, e.message);
          break; // nothing is half-applied: each file is one transaction
        }
      }
      db.pending = files.filter((f) => !done.has(f));
    } finally {
      try { await client.query('select pg_advisory_unlock(727001)'); } catch (_) {}
      client.release();
    }
  },
  async init() {
    const url = process.env.DATABASE_URL || '';
    if (!url) {
      console.log('[db] DATABASE_URL not set — API auth/sync disabled (static + health only)');
      return false;
    }
    try {
      const pg = await import('pg');
      pool = new pg.default.Pool({ connectionString: url, max: 10 });
      await pool.query('select 1');
      db.enabled = true;
      console.log('[db] Connected to PostgreSQL');
      if (process.env.AUTO_MIGRATE !== '0') {
        try { await db.migrate(); } catch (e) { console.error('[db] migrate error', e.message); }
      }
      return true;
    } catch (err) {
      console.error('[db] Failed to connect:', err.message);
      console.error('[db] Install driver with: npm install pg');
      db.enabled = false;
      return false;
    }
  },
  async query(text, params) {
    if (!pool) throw new Error('Database not available');
    return pool.query(text, params);
  },
  async withTenant(tenantId, fn) {
    if (!pool) throw new Error('Database not available');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (e) {
      try { await client.query('rollback'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  },
  async withAdmin(fn) {
    if (!pool) throw new Error('Database not available');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.platform_admin', 'on', true)`);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (e) {
      try { await client.query('rollback'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  },
  async end() {
    if (pool) await pool.end();
  },
};

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash: `${salt}:${hash}` };
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const next = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function checksumPayload(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('sha256').update(json).digest('hex');
}
