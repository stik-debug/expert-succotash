/**
 * MarginPilot HTTP API — /api/*
 * Bearer session tokens. Requires DATABASE_URL + migrations.
 */
import { db, hashPassword, verifyPassword, hashToken, newToken, checksumPayload } from './db.mjs';
import { sendPasswordResetEmail, emailConfigured } from './email.mjs';
import { handleControl, logEvent, clientIp } from './control.mjs';
import crypto from 'node:crypto';

const PLATFORM_OWNER = String(process.env.PLATFORM_OWNER_EMAIL || '').trim().toLowerCase();
const LOCAL_MODE = process.env.ALLOW_LOCAL_MODE === '1';
const fails = new Map(); // key -> { n, until }
function throttled(key) { const f = fails.get(key); return !!(f && f.until > Date.now() && f.n >= 6); }
function noteFail(key) { const f = fails.get(key); const n = f && f.until > Date.now() ? f.n + 1 : 1; fails.set(key, { n, until: Date.now() + 10 * 60e3 }); }

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
    `select s.id as session_id, s.user_id, s.tenant_id, s.expires_at, u.email, u.status as user_status, u.is_platform_admin, m.role, t.name as tenant_name, t.currency, t.status as tenant_status
     from sessions s
     join users u on u.id = s.user_id
     left join memberships m on m.user_id = s.user_id and m.tenant_id = s.tenant_id
     left join tenants t on t.id = s.tenant_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [th]
  );
  if (!rows.length) return null;
  if (rows[0].user_status === 'suspended' || rows[0].tenant_status === 'suspended') return null;
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
        version: '3.10.0',
        localMode: LOCAL_MODE,
        db: db.enabled,
        email: emailConfigured(),
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
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_email', message: 'Enter a valid email address' });
      if (password.length < 8) return json(res, 400, { error: 'password_too_short', message: 'Use at least 8 characters' });
      if (!name) return json(res, 400, { error: 'business_name_required', message: 'Enter your business name' });
      const ip = clientIp(req);
      if (throttled('reg:' + ip)) return json(res, 429, { error: 'too_many_attempts', message: 'Too many attempts. Try again in a few minutes.' });
      noteFail('reg:' + ip);

      const exists = await db.query(`select id from users where lower(email) = $1`, [email]);
      if (exists.rows.length) return json(res, 409, { error: 'email_taken', message: 'That email already has an account. Log in instead.' });

      const tenantId = crypto.randomUUID();
      const token = newToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
      const isAdmin = !!PLATFORM_OWNER && email === PLATFORM_OWNER;
      const userId = await db.withTenant(tenantId, async (c) => {
        const u = await c.query(
          `insert into users (email, password_hash, is_platform_admin, last_login_at) values ($1, $2, $3, now()) returning id`,
          [email, hashPassword(password).hash, isAdmin]
        );
        await c.query(`insert into tenants (id, name, country, currency) values ($1, $2, $3, $4)`, [tenantId, name, country, currency]);
        await c.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [tenantId, u.rows[0].id]);
        await c.query(`select seed_default_accounts($1)`, [tenantId]);
        await c.query(
          `insert into sessions (user_id, token_hash, tenant_id, expires_at, user_agent) values ($1, $2, $3, $4, $5)`,
          [u.rows[0].id, hashToken(token), tenantId, expires.toISOString(), req.headers['user-agent'] || null]
        );
        return u.rows[0].id;
      });
      await logEvent(null, { userId, tenantId, action: 'signup', ip });
      return json(res, 201, {
        token,
        expiresAt: expires.toISOString(),
        user: { id: userId, email },
        tenant: { id: tenantId, name, currency, country },
        role: 'owner',
        isPlatformAdmin: isAdmin,
      });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const ip = clientIp(req);
      const key = 'login:' + ip + ':' + email;
      if (throttled(key)) return json(res, 429, { error: 'too_many_attempts', message: 'Too many failed attempts. Try again in 10 minutes.' });
      const { rows } = await db.query(`select id, email, password_hash, status, is_platform_admin from users where lower(email) = $1`, [email]);
      if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
        noteFail(key);
        await logEvent(null, { userId: rows[0]?.id || null, action: 'login_failed', detail: rows.length ? null : { email }, ip });
        return json(res, 401, { error: 'invalid_credentials', message: 'Email or password is incorrect' });
      }
      const user = rows[0];
      if (user.status === 'suspended') return json(res, 403, { error: 'account_suspended', message: 'This account is suspended. Contact your business owner or support.' });
      let isAdmin = user.is_platform_admin;
      if (!isAdmin && PLATFORM_OWNER && user.email.toLowerCase() === PLATFORM_OWNER) {
        await db.query(`update users set is_platform_admin = true where id = $1`, [user.id]);
        isAdmin = true;
      }
      const mem = await db.query(
        `select m.tenant_id, m.role, t.name, t.currency, t.country, t.status
         from memberships m join tenants t on t.id = m.tenant_id
         where m.user_id = $1
         order by case when m.role = 'owner' then 0 else 1 end
         limit 1`,
        [user.id]
      );
      if (!mem.rows.length) return json(res, 403, { error: 'no_tenant', message: 'You were removed from this business.' });
      const m = mem.rows[0];
      if (m.status === 'suspended') return json(res, 403, { error: 'business_suspended', message: 'This business is suspended. Contact support.' });
      fails.delete(key);
      const token = newToken();
      const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
      await db.query(
        `insert into sessions (user_id, token_hash, tenant_id, expires_at, user_agent)
         values ($1, $2, $3, $4, $5)`,
        [user.id, hashToken(token), m.tenant_id, expires.toISOString(), req.headers['user-agent'] || null]
      );
      await db.query(`update users set last_login_at = now() where id = $1`, [user.id]);
      await logEvent(null, { userId: user.id, tenantId: m.tenant_id, action: 'login', ip });
      return json(res, 200, {
        token,
        expiresAt: expires.toISOString(),
        user: { id: user.id, email: user.email },
        tenant: { id: m.tenant_id, name: m.name, currency: m.currency, country: m.country },
        role: m.role,
        isPlatformAdmin: isAdmin,
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
        isPlatformAdmin: !!sess.is_platform_admin,
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


    if (path === '/api/auth/forgot-password' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const okResponse = () => json(res, 200, {
        ok: true,
        message: 'If that email is registered, a reset link has been sent. Check your inbox and spam folder.',
      });
      if (!email || !email.includes('@')) return okResponse();

      const { rows } = await db.query(`select id, email from users where lower(email) = $1`, [email]);
      if (!rows.length) return okResponse();

      const user = rows[0];
      const recent = await db.query(
        `select count(*)::int as n from password_reset_tokens
         where user_id = $1 and created_at > now() - interval '1 hour'`,
        [user.id]
      );
      if ((recent.rows[0]?.n || 0) >= 3) return okResponse();

      const token = newToken();
      const expires = new Date(Date.now() + 3600e3);
      await db.query(
        `insert into password_reset_tokens (user_id, token_hash, expires_at, request_ip)
         values ($1, $2, $3, $4)`,
        [user.id, hashToken(token), expires.toISOString(), req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null]
      );

      const ten = await db.query(
        `select t.name from memberships m join tenants t on t.id = m.tenant_id
         where m.user_id = $1 order by case when m.role = 'owner' then 0 else 1 end limit 1`,
        [user.id]
      );
      const origin = String(body.origin || req.headers.origin || '').replace(/\/$/, '');
      const base = origin || ('http://' + (req.headers.host || 'localhost'));
      const resetUrl = base + '/?reset_token=' + encodeURIComponent(token);

      try {
        await sendPasswordResetEmail({
          to: user.email,
          resetUrl,
          businessName: ten.rows[0]?.name || '',
        });
      } catch (e) {
        console.error('[auth] email send failed', e.message);
      }
      return okResponse();
    }

    if (path === '/api/auth/reset-password' && method === 'POST') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      const password = String(body.password || '');
      if (!token) return json(res, 400, { error: 'token_required' });
      if (password.length < 8) return json(res, 400, { error: 'password_too_short', message: 'Use at least 8 characters' });

      const th = hashToken(token);
      const { rows } = await db.query(
        `select id, user_id from password_reset_tokens
         where token_hash = $1 and used_at is null and expires_at > now()`,
        [th]
      );
      if (!rows.length) {
        return json(res, 400, {
          error: 'invalid_or_expired_token',
          message: 'This reset link is invalid or has expired. Request a new one.',
        });
      }

      const { hash } = hashPassword(password);
      await db.query(`update users set password_hash = $1 where id = $2`, [hash, rows[0].user_id]);
      await db.query(`update password_reset_tokens set used_at = now() where id = $1`, [rows[0].id]);
      await db.query(
        `update password_reset_tokens set used_at = now()
         where user_id = $1 and used_at is null and id <> $2`,
        [rows[0].user_id, rows[0].id]
      );
      await db.query(`delete from sessions where user_id = $1`, [rows[0].user_id]);

      return json(res, 200, { ok: true, message: 'Password updated. You can log in with your new password.' });
    }

    if (await handleControl({ req, res, path, method, json, readBody, authSession })) return true;

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
