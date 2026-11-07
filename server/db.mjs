/**
 * PostgreSQL access for MarginPilot API.
 * When DATABASE_URL is unset, db.enabled is false and the API runs in local-static mode.
 */
import crypto from 'node:crypto';

let pool = null;
export const db = {
  enabled: false,
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
