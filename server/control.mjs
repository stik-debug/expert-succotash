/**
 * Control center API: business-owner panel (/api/owner/*), platform admin (/api/admin/*), password change.
 * Platform admins see accounts, status and usage metadata only — never business records (sales, stock, customers).
 */
import { db, hashPassword, verifyPassword } from './db.mjs';

export const OWNER_ROLES = ['administrator', 'branch_manager', 'accountant', 'cashier', 'stock_manager', 'salesperson'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function logEvent(q, { userId = null, tenantId = null, action, detail = null, ip = null }) {
  try {
    await (q || db).query(
      `insert into security_events (user_id, tenant_id, action, detail, ip) values ($1, $2, $3, $4::jsonb, $5)`,
      [userId, tenantId, action, detail ? JSON.stringify(detail) : null, ip]
    );
  } catch (e) { console.warn('[events]', e.message); }
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null;
}

export async function handleControl({ req, res, path, method, json, readBody, authSession }) {
  const isOwnerPath = path.startsWith('/api/owner/');
  const isAdminPath = path.startsWith('/api/admin/');
  const isPwPath = path === '/api/auth/change-password';
  if (!isOwnerPath && !isAdminPath && !isPwPath) return false;

  const sess = await authSession(req);
  if (!sess) { json(res, 401, { error: 'unauthorized' }); return true; }
  const ip = clientIp(req);
  const seg = path.split('/').filter(Boolean); // api, owner|admin, a, b, c

  /* ---------- change own password ---------- */
  if (isPwPath && method === 'POST') {
    const body = await readBody(req);
    const cur = String(body.currentPassword || ''), next = String(body.password || '');
    if (next.length < 8) { json(res, 400, { error: 'password_too_short', message: 'Use at least 8 characters' }); return true; }
    const { rows } = await db.query(`select password_hash from users where id = $1`, [sess.user_id]);
    if (!rows.length || !verifyPassword(cur, rows[0].password_hash)) { json(res, 403, { error: 'wrong_password', message: 'Current password is incorrect' }); return true; }
    await db.query(`update users set password_hash = $1 where id = $2`, [hashPassword(next).hash, sess.user_id]);
    await db.query(`delete from sessions where user_id = $1 and id <> $2`, [sess.user_id, sess.session_id]);
    await logEvent(null, { userId: sess.user_id, tenantId: sess.tenant_id, action: 'password_changed', ip });
    json(res, 200, { ok: true });
    return true;
  }

  /* ---------- business owner panel ---------- */
  if (isOwnerPath) {
    if (sess.role !== 'owner') { json(res, 403, { error: 'owner_only', message: 'Only the business owner can use this.' }); return true; }
    const tid = sess.tenant_id;

    if (seg[2] === 'overview' && method === 'GET') {
      const data = await db.withTenant(tid, async (c) => {
        const t = (await c.query(`select id, name, country, currency, status, plan, created_at from tenants where id = app_tenant()`)).rows[0];
        const snap = (await c.query(`select revision, checksum, updated_at, pg_column_size(payload) as bytes from business_snapshots where tenant_id = app_tenant()`)).rows[0] || null;
        const members = (await c.query(
          `select u.id as user_id, u.email, u.status, u.last_login_at, m.role
           from memberships m join users u on u.id = m.user_id where m.tenant_id = $1
           order by case when m.role = 'owner' then 0 else 1 end, u.email`, [tid])).rows;
        const sessions = (await c.query(
          `select s.id, s.user_id, u.email, s.user_agent, s.created_at, s.last_seen_at
           from sessions s join users u on u.id = s.user_id
           where s.tenant_id = $1 and s.expires_at > now() order by s.last_seen_at desc limit 50`, [tid])).rows;
        const events = (await c.query(
          `select e.at, e.action, e.detail, u.email from security_events e left join users u on u.id = e.user_id
           where e.tenant_id = $1 order by e.at desc limit 25`, [tid])).rows;
        return { t, snap, members, sessions, events };
      });
      json(res, 200, {
        business: data.t && { id: data.t.id, name: data.t.name, country: data.t.country, currency: data.t.currency, status: data.t.status, plan: data.t.plan, createdAt: data.t.created_at },
        snapshot: data.snap && { revision: Number(data.snap.revision), updatedAt: data.snap.updated_at, bytes: Number(data.snap.bytes) },
        members: data.members.map((m) => ({ userId: m.user_id, email: m.email, role: m.role, status: m.status, lastLoginAt: m.last_login_at, isYou: m.user_id === sess.user_id })),
        sessions: data.sessions.map((s) => ({ id: s.id, email: s.email, userAgent: s.user_agent, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === sess.session_id })),
        events: data.events.map((e) => ({ at: e.at, action: e.action, email: e.email, detail: e.detail })),
      });
      return true;
    }

    if (seg[2] === 'business' && method === 'PUT') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) { json(res, 400, { error: 'business_name_required' }); return true; }
      const currency = String(b.currency || 'KES').toUpperCase().slice(0, 3);
      const country = String(b.country || 'KE').toUpperCase().slice(0, 2);
      await db.withTenant(tid, (c) => c.query(`update tenants set name = $1, currency = $2, country = $3 where id = app_tenant()`, [name, currency, country]));
      await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'business_updated', detail: { name, currency, country }, ip });
      json(res, 200, { ok: true });
      return true;
    }

    if (seg[2] === 'members' && !seg[3] && method === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const role = String(b.role || '');
      if (!email.includes('@')) { json(res, 400, { error: 'invalid_email' }); return true; }
      if (password.length < 8) { json(res, 400, { error: 'password_too_short', message: 'Temporary password needs 8+ characters' }); return true; }
      if (!OWNER_ROLES.includes(role)) { json(res, 400, { error: 'invalid_role' }); return true; }
      const lim = (await db.withTenant(tid, (c) => c.query(`select p.limits->>'users' as u, (select count(*) from memberships where tenant_id = $1)::int as n from subscriptions s join plans p on p.code = s.plan_code where s.tenant_id = app_tenant()`, [tid]))).rows[0];
      if (lim && lim.u && lim.n >= Number(lim.u)) { json(res, 402, { error: 'plan_limit', message: 'Your plan allows ' + lim.u + ' users. Upgrade to add more.' }); return true; }
      const ex = await db.query(`select 1 from users where lower(email) = $1`, [email]);
      if (ex.rows.length) { json(res, 409, { error: 'email_taken', message: 'That email already has an account.' }); return true; }
      const id = await db.withTenant(tid, async (c) => {
        const u = await c.query(`insert into users (email, password_hash) values ($1, $2) returning id`, [email, hashPassword(password).hash]);
        await c.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)`, [tid, u.rows[0].id, role]);
        return u.rows[0].id;
      });
      await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'member_added', detail: { email, role }, ip });
      json(res, 201, { ok: true, userId: id });
      return true;
    }

    if (seg[2] === 'members' && UUID.test(seg[3] || '')) {
      const uid = seg[3];
      const mem = (await db.query(`select m.role, u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 and m.user_id = $2`, [tid, uid])).rows[0];
      if (!mem) { json(res, 404, { error: 'member_not_found' }); return true; }
      if (mem.role === 'owner' || uid === sess.user_id) { json(res, 400, { error: 'cannot_modify_owner', message: 'The owner account cannot be changed here.' }); return true; }

      if (method === 'PUT') {
        const b = await readBody(req);
        if (b.role !== undefined) {
          if (!OWNER_ROLES.includes(b.role)) { json(res, 400, { error: 'invalid_role' }); return true; }
          await db.query(`update memberships set role = $1 where tenant_id = $2 and user_id = $3`, [b.role, tid, uid]);
          await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'member_role_changed', detail: { email: mem.email, role: b.role }, ip });
        }
        if (b.password !== undefined) {
          if (String(b.password).length < 8) { json(res, 400, { error: 'password_too_short', message: 'Password needs 8+ characters' }); return true; }
          await db.query(`update users set password_hash = $1 where id = $2`, [hashPassword(String(b.password)).hash, uid]);
          await db.query(`delete from sessions where user_id = $1`, [uid]);
          await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'member_password_reset', detail: { email: mem.email }, ip });
        }
        if (b.status !== undefined) {
          if (!['active', 'suspended'].includes(b.status)) { json(res, 400, { error: 'invalid_status' }); return true; }
          await db.query(`update users set status = $1 where id = $2`, [b.status, uid]);
          if (b.status === 'suspended') await db.query(`delete from sessions where user_id = $1`, [uid]);
          await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'member_' + b.status, detail: { email: mem.email }, ip });
        }
        json(res, 200, { ok: true });
        return true;
      }
      if (method === 'DELETE') {
        await db.query(`delete from sessions where user_id = $1 and tenant_id = $2`, [uid, tid]);
        await db.query(`delete from memberships where tenant_id = $1 and user_id = $2`, [tid, uid]);
        await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'member_removed', detail: { email: mem.email }, ip });
        json(res, 200, { ok: true });
        return true;
      }
    }

    if (seg[2] === 'sessions' && seg[3] === 'revoke-others' && method === 'POST') {
      await db.query(`delete from sessions where tenant_id = $1 and id <> $2`, [tid, sess.session_id]);
      await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'sessions_revoked_all', ip });
      json(res, 200, { ok: true });
      return true;
    }
    if (seg[2] === 'sessions' && UUID.test(seg[3] || '') && method === 'DELETE') {
      await db.query(`delete from sessions where id = $1 and tenant_id = $2`, [seg[3], tid]);
      await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'session_revoked', ip });
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: 'not_found', path });
    return true;
  }

  /* ---------- platform admin ---------- */
  if (!sess.is_platform_admin) { json(res, 403, { error: 'admin_only', message: 'Platform admin access required.' }); return true; }
  const q = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
  const like = '%' + q.replace(/[%_\\]/g, '') + '%';

  if (seg[2] === 'overview' && method === 'GET') {
    const r = await db.withAdmin(async (c) => {
      const n = async (sql) => Number((await c.query(sql)).rows[0].n);
      return {
        tenants: await n(`select count(*) n from tenants`),
        suspendedTenants: await n(`select count(*) n from tenants where status = 'suspended'`),
        users: await n(`select count(*) n from users`),
        activeSessions: await n(`select count(*) n from sessions where expires_at > now()`),
        withSnapshot: await n(`select count(*) n from business_snapshots`),
        signups7d: await n(`select count(*) n from tenants where created_at > now() - interval '7 days'`),
        signups30d: await n(`select count(*) n from tenants where created_at > now() - interval '30 days'`),
        activeToday: await n(`select count(*) n from users where last_login_at > now() - interval '1 day'`),
        events: (await c.query(
          `select e.at, e.action, e.detail, e.ip, u.email, t.name as tenant from security_events e
           left join users u on u.id = e.user_id left join tenants t on t.id = e.tenant_id order by e.at desc limit 30`)).rows,
      };
    });
    json(res, 200, r);
    return true;
  }

  if (seg[2] === 'tenants' && !seg[3] && method === 'GET') {
    const rows = await db.withAdmin(async (c) => (await c.query(
      `select t.id, t.name, t.country, t.currency, t.status, t.plan, t.created_at,
              (select u.email from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id and m.role = 'owner' limit 1) as owner_email,
              (select count(*) from memberships m where m.tenant_id = t.id)::int as members,
              s.revision, s.updated_at as synced_at, pg_column_size(s.payload) as bytes,
              sub.current_period_end::text as period_end, t.billing_exempt as exempt,
              mp_billing_state(sub.current_period_end, sub.grace_until, sub.status, t.billing_exempt) as bill
       from tenants t left join business_snapshots s on s.tenant_id = t.id left join subscriptions sub on sub.tenant_id = t.id
       where $1 = '%%' or lower(t.name) like $1 or t.id::text like $1
          or exists (select 1 from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id and lower(u.email) like $1)
       order by t.created_at desc limit 200`, [like])).rows);
    json(res, 200, { tenants: rows.map((r) => ({
      id: r.id, name: r.name, country: r.country, currency: r.currency, status: r.status, plan: r.plan, createdAt: r.created_at,
      ownerEmail: r.owner_email, members: r.members, bill: r.bill, periodEnd: r.period_end, exempt: r.exempt, revision: r.revision ? Number(r.revision) : 0, syncedAt: r.synced_at, bytes: r.bytes ? Number(r.bytes) : 0,
    })) });
    return true;
  }

  if (seg[2] === 'tenants' && UUID.test(seg[3] || '') && method === 'PUT') {
    const b = await readBody(req);
    const sets = [], vals = [];
    if (b.status !== undefined) {
      if (!['active', 'suspended'].includes(b.status)) { json(res, 400, { error: 'invalid_status' }); return true; }
      vals.push(b.status); sets.push('status = $' + vals.length);
    }
    if (b.plan !== undefined) {
      const plan = String(b.plan).trim().toLowerCase().slice(0, 30);
      if (!/^[a-z0-9_-]+$/.test(plan)) { json(res, 400, { error: 'invalid_plan' }); return true; }
      vals.push(plan); sets.push('plan = $' + vals.length);
    }
    if (!sets.length) { json(res, 400, { error: 'nothing_to_update' }); return true; }
    vals.push(seg[3]);
    const done = await db.withAdmin(async (c) => {
      const r = await c.query(`update tenants set ${sets.join(', ')} where id = $${vals.length} returning name`, vals);
      if (r.rowCount && b.status === 'suspended') await c.query(`delete from sessions where tenant_id = $1`, [seg[3]]);
      return r.rowCount;
    });
    if (!done) { json(res, 404, { error: 'tenant_not_found' }); return true; }
    await logEvent(null, { userId: sess.user_id, tenantId: seg[3], action: 'admin_tenant_update', detail: { status: b.status, plan: b.plan }, ip });
    json(res, 200, { ok: true });
    return true;
  }

  if (seg[2] === 'users' && !seg[3] && method === 'GET') {
    const rows = await db.withAdmin(async (c) => (await c.query(
      `select u.id, u.email, u.status, u.is_platform_admin, u.last_login_at, u.created_at,
              (select string_agg(t.name || ' (' || m.role || ')', ', ') from memberships m join tenants t on t.id = m.tenant_id where m.user_id = u.id) as businesses
       from users u where $1 = '%%' or lower(u.email) like $1 order by u.created_at desc limit 200`, [like])).rows);
    json(res, 200, { users: rows.map((r) => ({ id: r.id, email: r.email, status: r.status, isPlatformAdmin: r.is_platform_admin, lastLoginAt: r.last_login_at, createdAt: r.created_at, businesses: r.businesses || '' })) });
    return true;
  }

  if (seg[2] === 'users' && UUID.test(seg[3] || '') && method === 'PUT') {
    const b = await readBody(req);
    if (seg[3] === sess.user_id) { json(res, 400, { error: 'cannot_modify_self', message: 'You cannot change your own account here.' }); return true; }
    if (b.status !== undefined) {
      if (!['active', 'suspended'].includes(b.status)) { json(res, 400, { error: 'invalid_status' }); return true; }
      const r = await db.query(`update users set status = $1 where id = $2 and not is_platform_admin`, [b.status, seg[3]]);
      if (!r.rowCount) { json(res, 404, { error: 'user_not_found_or_protected' }); return true; }
      if (b.status === 'suspended') await db.query(`delete from sessions where user_id = $1`, [seg[3]]);
      await logEvent(null, { userId: sess.user_id, action: 'admin_user_' + b.status, detail: { target: seg[3] }, ip });
    }
    if (b.revokeSessions) {
      await db.query(`delete from sessions where user_id = $1`, [seg[3]]);
      await logEvent(null, { userId: sess.user_id, action: 'admin_sessions_revoked', detail: { target: seg[3] }, ip });
    }
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 404, { error: 'not_found', path });
  return true;
}
