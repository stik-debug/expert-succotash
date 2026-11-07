-- MarginPilot migration 005: Paystack billing, trial, automatic lock; RLS fixes for login/session lookups.
create or replace function mp_today() returns date language sql stable as
$$ select (now() at time zone 'Africa/Nairobi')::date $$;

alter table tenants add column if not exists billing_exempt boolean not null default false;

-- FIX (follow-up to 004): login and session checks read memberships/tenants before a tenant is known.
-- Without these policies RLS hides the rows, so logins fail and tenant suspension is not seen.
drop policy if exists memberships_api on memberships;
create policy memberships_api on memberships for all using (true) with check (true);
drop policy if exists tenants_api_read on tenants;
create policy tenants_api_read on tenants for select using (true);

-- One subscription row per business. Dates are Nairobi calendar days.
create unique index if not exists subscriptions_tenant_uq on subscriptions (tenant_id);
drop policy if exists platform_admin_subs on subscriptions;
create policy platform_admin_subs on subscriptions for all using (app_platform_admin()) with check (app_platform_admin());

-- Single definition of "is this business locked": locked once today is past grace_until.
create or replace function mp_billing_state(p_end date, p_grace date, p_status text, p_exempt boolean)
returns text language sql stable as $$
  select case
    when p_exempt then 'exempt'
    when p_end is null then 'locked'
    when mp_today() <= p_end then (case when p_status = 'trial' then 'trial' else 'active' end)
    when mp_today() <= coalesce(p_grace, p_end) then 'past_due'
    else 'locked' end
$$;

-- Every Paystack checkout (and admin grant). A reference can only be fulfilled once.
create table if not exists billing_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id),
  reference text not null unique,
  provider text not null default 'paystack',
  plan_code text not null references plans (code),
  months int not null check (months between 1 and 24),
  amount bigint not null check (amount >= 0),
  currency char(3) not null default 'KES',
  status text not null default 'pending' check (status in ('pending','success','failed','mismatch')),
  channel text,
  period_end date,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists billing_payments_tenant_idx on billing_payments (tenant_id, created_at desc);

grant select, insert, update on billing_payments to marginpilot_app;
grant update on subscriptions to marginpilot_app;
grant update (billing_exempt) on tenants to marginpilot_app;

-- Existing businesses get a fresh trial so nobody is locked out by the upgrade.
select set_config('app.platform_admin', 'on', true);
insert into subscriptions (tenant_id, plan_code, status, current_period_end, grace_until)
select t.id, 'small_shop', 'trial', mp_today() + 14, mp_today() + 14 from tenants t
where not exists (select 1 from subscriptions s where s.tenant_id = t.id);
