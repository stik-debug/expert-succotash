/**
 * Paystack subscriptions with automatic lock.
 * Each period is a Paystack Checkout payment (card or M-Pesa). A payment extends current_period_end; when today passes
 * grace_until the business is locked until the next successful payment. Fulfilment is idempotent per reference and is
 * triggered by the webhook, the browser return, and a self-healing check whenever status is read.
 */
import crypto from 'node:crypto';
import { db } from './db.mjs';
import { logEvent, clientIp } from './control.mjs';

const secret = () => process.env.PAYSTACK_SECRET_KEY || '';
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;
const GRACE_DAYS = process.env.GRACE_DAYS !== undefined ? Number(process.env.GRACE_DAYS) : 3;
const YEAR_PRICED_MONTHS = 10; // pay for 10, get 12
const CUR = 'KES';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const priceFor = (monthly, months) => Number(monthly) * (months === 12 ? YEAR_PRICED_MONTHS : months);

async function planPrices() {
  const { rows } = await db.query(
    `select distinct on (p.code) p.code, p.name, p.limits, pp.amount
     from plans p join plan_prices pp on pp.plan_code = p.code
     where p.active and pp.currency = $1 order by p.code, pp.effective_from desc, pp.id desc`, [CUR]);
  return rows.map((r) => ({ plan: r.code, name: r.name, limits: r.limits, monthly: Number(r.amount), yearly: priceFor(r.amount, 12) }));
}

export async function createTrial(client, tenantId) {
  await client.query(
    `insert into subscriptions (tenant_id, plan_code, status, current_period_end, grace_until)
     values ($1, 'small_shop', 'trial', mp_today() + $2::int, mp_today() + $2::int) on conflict (tenant_id) do nothing`,
    [tenantId, TRIAL_DAYS]);
}

export async function getBilling(tenantId) {
  const read = () => db.withTenant(tenantId, async (c) => {
    const s = (await c.query(
      `select s.plan_code, s.status, s.current_period_end::text as period_end, s.grace_until::text as grace_until,
              t.billing_exempt as exempt, mp_billing_state(s.current_period_end, s.grace_until, s.status, t.billing_exempt) as state,
              (s.current_period_end - mp_today()) as days_left
       from subscriptions s join tenants t on t.id = s.tenant_id where s.tenant_id = app_tenant()`)).rows[0];
    const history = (await c.query(
      `select reference, amount, currency, plan_code, months, channel, paid_at, period_end::text as period_end
       from billing_payments where tenant_id = $1 and status = 'success' order by paid_at desc nulls last limit 10`, [tenantId])).rows;
    return { s, history };
  });
  let r = await read();
  if (!r.s) { await db.withTenant(tenantId, (c) => createTrial(c, tenantId)); r = await read(); }
  return { ...r.s, locked: r.s.state === 'locked', history: r.history };
}

async function paystack(method, path, body) {
  const res = await fetch('https://api.paystack.co' + path, {
    method,
    headers: { Authorization: 'Bearer ' + secret(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) { const e = new Error((data && data.message) || 'Paystack error ' + res.status); e.status = res.status; throw e; }
  return data;
}

// Extend a business's paid period. Runs inside withAdmin.
async function extend(c, tenantId, planCode, months) {
  const r = await c.query(
    `with base as (select greatest(coalesce((select current_period_end from subscriptions where tenant_id = $1::uuid), mp_today()), mp_today()) as b),
          ne as (select (b + ($3::int * interval '1 month'))::date as e from base)
     insert into subscriptions (tenant_id, plan_code, status, current_period_end, grace_until)
     select $1::uuid, coalesce($2::text, 'small_shop'), 'active', e, e + $4::int from ne
     on conflict (tenant_id) do update set
       plan_code = coalesce($2::text, subscriptions.plan_code), status = 'active',
       current_period_end = excluded.current_period_end, grace_until = excluded.grace_until
     returning current_period_end::text as period_end`,
    [tenantId, planCode, months, GRACE_DAYS]);
  return r.rows[0].period_end;
}

/** Verify with Paystack, then fulfil exactly once. Safe to call repeatedly from webhook, callback and status polling. */
export async function fulfill(reference) {
  const pay = (await db.query(`select * from billing_payments where reference = $1`, [reference])).rows[0];
  if (!pay) return { ok: false, reason: 'unknown_reference' };
  if (pay.status === 'success') return { ok: true, already: true, tenantId: pay.tenant_id };
  if (pay.status !== 'pending') return { ok: false, reason: pay.status, tenantId: pay.tenant_id };
  const v = await paystack('GET', '/transaction/verify/' + encodeURIComponent(reference));
  const d = v.data;
  if (!d || d.status !== 'success') return { ok: false, reason: (d && d.status) || 'not_paid', tenantId: pay.tenant_id };
  if (Number(d.amount) !== Number(pay.amount) || String(d.currency).toUpperCase() !== String(pay.currency).trim()) {
    await db.query(`update billing_payments set status = 'mismatch' where reference = $1 and status = 'pending'`, [reference]);
    await logEvent(null, { tenantId: pay.tenant_id, action: 'payment_mismatch', detail: { reference, paid: d.amount, expected: Number(pay.amount) } });
    return { ok: false, reason: 'mismatch', tenantId: pay.tenant_id };
  }
  await db.withAdmin(async (c) => {
    const u = await c.query(`update billing_payments set status = 'success', paid_at = now(), channel = $2 where reference = $1 and status = 'pending' returning *`, [reference, d.channel || null]);
    if (!u.rowCount) return; // another request already fulfilled it
    const p = u.rows[0];
    const end = await extend(c, p.tenant_id, p.plan_code, p.months);
    await c.query(`update billing_payments set period_end = $2 where id = $1`, [p.id, end]);
  });
  await logEvent(null, { tenantId: pay.tenant_id, action: 'payment_success', detail: { reference, amount: Number(pay.amount), months: pay.months } });
  return { ok: true, tenantId: pay.tenant_id };
}

async function reconcile(tenantId) {
  const { rows } = await db.query(
    `select reference from billing_payments where tenant_id = $1 and status = 'pending' and created_at > now() - interval '2 days'
     order by created_at desc limit 2`, [tenantId]);
  for (const r of rows) { try { await fulfill(r.reference); } catch (e) { /* retried on next poll */ } }
}

async function readRaw(req, limit = 1_000_000) {
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > limit) throw new Error('Body too large'); chunks.push(ch); }
  return Buffer.concat(chunks);
}

export async function handleWebhook(req, res, json) {
  const raw = await readRaw(req);
  const sig = String(req.headers['x-paystack-signature'] || '');
  const expected = crypto.createHmac('sha512', secret()).update(raw).digest('hex');
  const valid = !!secret() && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) return json(res, 401, { error: 'invalid_signature' });
  let ev; try { ev = JSON.parse(raw.toString('utf8')); } catch (e) { return json(res, 400, { error: 'invalid_json' }); }
  try {
    if (ev.event === 'charge.success' && ev.data && ev.data.reference) await fulfill(String(ev.data.reference));
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('[billing] webhook', e.message);
    return json(res, 500, { error: 'retry' }); // non-200 makes Paystack retry
  }
}

export async function handleBilling({ req, res, path, method, json, readBody, authSession }) {
  const adminBilling = path.startsWith('/api/admin/billing');
  if (!path.startsWith('/api/billing/') && !adminBilling) return false;
  const sess = await authSession(req);
  if (!sess) { json(res, 401, { error: 'unauthorized' }); return true; }
  const tid = sess.tenant_id, ip = clientIp(req);
  const seg = path.split('/').filter(Boolean);

  if (adminBilling) {
    if (!sess.is_platform_admin) { json(res, 403, { error: 'admin_only' }); return true; }
    if (!seg[2] && method === 'GET') {
      const r = await db.withAdmin(async (c) => ({
        states: (await c.query(`select mp_billing_state(s.current_period_end, s.grace_until, s.status, t.billing_exempt) as state, count(*)::int as n
          from tenants t left join subscriptions s on s.tenant_id = t.id group by 1`)).rows,
        revenue: (await c.query(`select coalesce(sum(amount) filter (where paid_at > now() - interval '30 days'), 0) as d30, coalesce(sum(amount), 0) as total
          from billing_payments where status = 'success' and provider = 'paystack'`)).rows[0],
        recent: (await c.query(`select p.reference, p.amount, p.currency, p.status, p.provider, p.months, p.channel, p.created_at, p.paid_at, t.name as tenant
          from billing_payments p join tenants t on t.id = p.tenant_id order by p.created_at desc limit 25`)).rows,
      }));
      json(res, 200, { states: Object.fromEntries(r.states.map((x) => [x.state || 'none', x.n])), revenue30d: Number(r.revenue.d30), revenueTotal: Number(r.revenue.total), recent: r.recent });
      return true;
    }
    if (UUID.test(seg[2] || '') && method === 'PUT') {
      const b = await readBody(req);
      if (b.exempt !== undefined) {
        await db.withAdmin((c) => c.query(`update tenants set billing_exempt = $1 where id = $2`, [!!b.exempt, seg[2]]));
        await logEvent(null, { userId: sess.user_id, tenantId: seg[2], action: b.exempt ? 'admin_billing_exempt' : 'admin_billing_unexempt', ip });
      }
      if (b.grantMonths !== undefined) {
        const m = Number(b.grantMonths);
        if (!Number.isInteger(m) || m < 1 || m > 24) { json(res, 400, { error: 'invalid_months' }); return true; }
        const end = await db.withAdmin(async (c) => {
          const e = await extend(c, seg[2], null, m);
          await c.query(`insert into billing_payments (tenant_id, reference, provider, plan_code, months, amount, status, paid_at, period_end, created_by)
            values ($1, $2, 'admin', (select plan_code from subscriptions where tenant_id = $1), $3, 0, 'success', now(), $4, $5)`,
            [seg[2], 'grant_' + crypto.randomUUID(), m, e, sess.user_id]);
          return e;
        });
        await logEvent(null, { userId: sess.user_id, tenantId: seg[2], action: 'admin_billing_grant', detail: { months: m, periodEnd: end }, ip });
      }
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: 'not_found' });
    return true;
  }

  if (seg[2] === 'status' && method === 'GET') {
    await reconcile(tid);
    const b = await getBilling(tid);
    json(res, 200, {
      state: b.state, locked: b.locked, exempt: b.exempt, plan: b.plan_code, periodEnd: b.period_end, graceUntil: b.grace_until,
      daysLeft: b.days_left === null ? null : Number(b.days_left), configured: !!secret(), graceDays: GRACE_DAYS,
      prices: await planPrices(), history: b.history.map((h) => ({ ...h, amount: Number(h.amount) })),
    });
    return true;
  }

  if (sess.role !== 'owner') { json(res, 403, { error: 'owner_only', message: 'Only the business owner can pay for the subscription.' }); return true; }

  if (seg[2] === 'checkout' && method === 'POST') {
    if (!secret()) { json(res, 503, { error: 'billing_not_configured', message: 'Payments are not switched on yet. Contact support.' }); return true; }
    const b = await readBody(req);
    const months = Number(b.months);
    if (![1, 12].includes(months)) { json(res, 400, { error: 'invalid_months' }); return true; }
    const plan = (await planPrices()).find((p) => p.plan === b.plan);
    if (!plan) { json(res, 400, { error: 'invalid_plan' }); return true; }
    const recent = await db.query(`select count(*)::int n from billing_payments where tenant_id = $1 and created_at > now() - interval '1 hour'`, [tid]);
    if (recent.rows[0].n >= 10) { json(res, 429, { error: 'too_many_attempts', message: 'Too many payment attempts. Try again later.' }); return true; }
    const amount = priceFor(plan.monthly, months);
    const reference = 'mp_' + tid.slice(0, 8) + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
    await db.query(
      `insert into billing_payments (tenant_id, reference, plan_code, months, amount, currency, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
      [tid, reference, plan.plan, months, amount, CUR, sess.user_id]);
    const base = String(process.env.APP_URL || req.headers.origin || '').replace(/\/$/, '') || ('https://' + (req.headers.host || 'localhost'));
    try {
      const r = await paystack('POST', '/transaction/initialize', {
        email: sess.email, amount, currency: CUR, reference,
        callback_url: base + '/?billing=return',
        metadata: { tenant_id: tid, plan: plan.plan, months },
      });
      await logEvent(null, { userId: sess.user_id, tenantId: tid, action: 'checkout_started', detail: { reference, amount, months, plan: plan.plan }, ip });
      json(res, 200, { url: r.data.authorization_url, reference });
    } catch (e) {
      await db.query(`update billing_payments set status = 'failed' where reference = $1`, [reference]);
      console.error('[billing] initialize', e.message);
      json(res, 502, { error: 'paystack_error', message: 'Could not start the payment. Try again.' });
    }
    return true;
  }

  if (seg[2] === 'verify' && method === 'POST') {
    const b = await readBody(req);
    const ref = String(b.reference || '');
    const own = await db.query(`select 1 from billing_payments where reference = $1 and tenant_id = $2`, [ref, tid]);
    if (!own.rows.length) { json(res, 404, { error: 'unknown_reference' }); return true; }
    try { const r = await fulfill(ref); json(res, 200, { ok: r.ok, reason: r.reason || null }); }
    catch (e) { json(res, 502, { error: 'paystack_error', message: 'Could not confirm the payment yet. It will unlock automatically once confirmed.' }); }
    return true;
  }

  json(res, 404, { error: 'not_found', path });
  return true;
}
