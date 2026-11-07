/**
 * MarginPilot HTTP API — /api/*
 * Bearer session tokens. Requires DATABASE_URL + migrations.
 */
import { db, hashPassword, verifyPassword, hashToken, newToken, checksumPayload } from './db.mjs';

const SESSION_DAYS = 14;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function authSession(req) {
  const token = bearer(req);
  if (!token) return null;
  const th = hashToken(token);
  const { rows } = await db.query(
    `select s.id as session_id, s.user_id, s.tenant_id, s.expires_at, u.email, m.role, t.name as tenant_name, t.currency
     from sessions s
     join users u on u.id = s.user_id
     left join memberships m on m.user_id = s.user_id and m.tenant_id = s.tenant_id
     left join tenants t on t.id = s.tenant_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [th]
  );
  if (!rows.length) return null;
  await db.query(`update sessions set last_seen_at = now() where id = $1`, [rows[0].session_id]);
  return rows[0];
}

export async function handleApi(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  try {
    if (path === '/api/health' && method === 'GET') {
      json(res, 200, {
        ok: true,
        service: 'marginpilot',
        version: '3.8.0',
        db: db.enabled,
        time: new Date().toISOString(),
      });
      return true;
    }

    if (!path.startsWith('/api/')) return false;

    if (!db.enabled) {
      json(res, 503, {
        error: 'database_unavailable',
        message: 'Set DATABASE_URL and run migrations to enable auth and sync. The browser app still works offline.',
      });
      return true;
    }

    if (path === '/api/auth/register' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.businessName || body.name || '').trim();
      const currency = String(body.currency || 'KES').toUpperCase().slice(0, 3);
      const country = String(body.country || 'KE').toUpperCase().slice(0, 2);
      if (!email || !email.includes('@')) return json(res, 400, { error: 'invalid_email' });
      if (password.length < 8) return json(res, 400, { error: 'password_too_short', message: 'Use at least 8 characters' });
      if (!name) return json(res, 400, { error: 'business_name_required' });

      const exists = await db.query(`select id from users where lower(email) = $1`, [email]);
      if (exists.rows.length) return json(res, 409, { error: 'email_taken' });

      const { hash } = hashPassword(password);
      const userIns = await db.query(
        `insert into users (email, password_hash) values ($1, $2) returning id`,
        [email, hash]
      );
      const userId = userIns.rows[0].id;
      const tenIns = await db.query(
        `insert into tenants (name, country, currency) values ($1, $2, $3) returning id`,
        [name, country, currency]
      );
      const tenantId = tenIns.rows[0].id;
      await db.query(
        `insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`,
        [tenantId, userId]
      );
      try {
        await db.query(`select seed_default_accounts($1)`, [tenantId]);
      } catch (e) {
        console.warn('[api] seed_default_accounts:', e.message);
      }

      const token = newToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
      await db.query(
        `insert into sessions (user_id, token_hash, tenant_id, expires_at, user_agent)
         values ($1, $2, $3, $4, $5)`,
        [userId, hashToken(token), tenantId, expires.toISOString(), req.headers['user-agent'] || null]
      );

      return json(res, 201, {
        token,
        expiresAt: expires.toISOString(),
        user: { id: userId, email },
        tenant: { id: tenantId, name, currency, country },
        role: 'owner',
      });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const { rows } = await db.query(`select id, email, password_hash from users where lower(email) = $1`, [email]);
      if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
        return json(res, 401, { error: 'invalid_credentials' });
      }
      const user = rows[0];
      const mem = await db.query(
        `select m.tenant_id, m.role, t.name, t.currency, t.country
         from memberships m join tenants t on t.id = m.tenant_id
         where m.user_id = $1
         order by case when m.role = 'owner' then 0 else 1 end
         limit 1`,
        [user.id]
      );
      if (!mem.rows.length) return json(res, 403, { error: 'no_tenant' });
      const m = mem.rows[0];
      const token = newToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
      await db.query(
        `insert into sessions (user_id, token_hash, tenant_id, expires_at, user_agent)
         values ($1, $2, $3, $4, $5)`,
        [user.id, hashToken(token), m.tenant_id, expires.toISOString(), req.headers['user-agent'] || null]
      );
      return json(res, 200, {
        token,
        expiresAt: expires.toISOString(),
        user: { id: user.id, email: user.email },
        tenant: { id: m.tenant_id, name: m.name, currency: m.currency, country: m.country },
        role: m.role,
      });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const token = bearer(req);
      if (token) await db.query(`delete from sessions where token_hash = $1`, [hashToken(token)]);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const sess = await authSession(req);
      if (!sess) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, {
        user: { id: sess.user_id, email: sess.email },
        tenant: { id: sess.tenant_id, name: sess.tenant_name, currency: sess.currency },
        role: sess.role,
      });
    }

    if (path === '/api/sync/snapshot' && method === 'GET') {
      const sess = await authSession(req);
      if (!sess?.tenant_id) return json(res, 401, { error: 'unauthorized' });
      const data = await db.withTenant(sess.tenant_id, async (client) => {
        const r = await client.query(
          `select revision, payload, checksum, updated_at from business_snapshots where tenant_id = app_tenant()`
        );
        return r.rows[0] || null;
      });
      if (!data) return json(res, 404, { error: 'no_snapshot' });
      return json(res, 200, {
        revision: Number(data.revision),
        checksum: data.checksum,
        updatedAt: data.updated_at,
        payload: data.payload,
      });
    }

    if (path === '/api/sync/snapshot' && method === 'PUT') {
      const sess = await authSession(req);
      if (!sess?.tenant_id) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req, 5_000_000);
      if (!body.payload || typeof body.payload !== 'object') {
        return json(res, 400, { error: 'payload_required' });
      }
      const baseRevision = Number(body.baseRevision || 0);
      const sum = checksumPayload(body.payload);
      try {
        const result = await db.withTenant(sess.tenant_id, async (client) => {
          const cur = await client.query(
            `select revision from business_snapshots where tenant_id = app_tenant() for update`
          );
          if (cur.rows.length) {
            const rev = Number(cur.rows[0].revision);
            if (baseRevision !== rev) {
              const err = new Error('conflict');
              err.code = 'conflict';
              err.revision = rev;
              throw err;
            }
            const upd = await client.query(
              `update business_snapshots
               set revision = revision + 1, payload = $1::jsonb, checksum = $2, updated_by = $3, updated_at = now()
               where tenant_id = app_tenant()
               returning revision, updated_at, checksum`,
              [JSON.stringify(body.payload), sum, sess.user_id]
            );
            return upd.rows[0];
          }
          const ins = await client.query(
            `insert into business_snapshots (tenant_id, revision, payload, checksum, updated_by)
             values (app_tenant(), 1, $1::jsonb, $2, $3)
             returning revision, updated_at, checksum`,
            [JSON.stringify(body.payload), sum, sess.user_id]
          );
          return ins.rows[0];
        });
        return json(res, 200, {
          revision: Number(result.revision),
          checksum: result.checksum,
          updatedAt: result.updated_at,
        });
      } catch (e) {
        if (e.code === 'conflict') {
          return json(res, 409, {
            error: 'revision_conflict',
            revision: e.revision,
            message: 'Pull latest snapshot before pushing',
          });
        }
        throw e;
      }
    }

    if (path === '/api/sync/status' && method === 'GET') {
      const sess = await authSession(req);
      if (!sess?.tenant_id) return json(res, 401, { error: 'unauthorized' });
      const data = await db.withTenant(sess.tenant_id, async (client) => {
        const r = await client.query(
          `select revision, checksum, updated_at from business_snapshots where tenant_id = app_tenant()`
        );
        return r.rows[0] || null;
      });
      return json(res, 200, {
        tenantId: sess.tenant_id,
        revision: data ? Number(data.revision) : 0,
        checksum: data?.checksum || null,
        updatedAt: data?.updated_at || null,
      });
    }

    json(res, 404, { error: 'not_found', path });
    return true;
  } catch (err) {
    console.error('[api]', err);
    if (err instanceof SyntaxError) return json(res, 400, { error: 'invalid_json' });
    if (String(err.message || '').includes('Body too large')) return json(res, 413, { error: 'body_too_large' });
    json(res, 500, { error: 'server_error', message: 'Unexpected server error' });
    return true;
  }
}
