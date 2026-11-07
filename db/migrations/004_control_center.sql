-- MarginPilot migration 004: platform admin, account status, security events, RLS fixes for signup/login.
alter table users add column if not exists is_platform_admin boolean not null default false;
alter table users add column if not exists status text not null default 'active' check (status in ('active','suspended'));
alter table users add column if not exists last_login_at timestamptz;
alter table tenants add column if not exists status text not null default 'active' check (status in ('active','suspended'));
alter table tenants add column if not exists plan text not null default 'free';

-- Signup creates the tenant inside a transaction with app.tenant_id = the new id; this keeps RLS satisfied.
-- Sessions are only ever touched by the API (looked up by token hash), so the old deny-all policy blocked logins.
drop policy if exists sessions_deny_all on sessions;
drop policy if exists sessions_api on sessions;
create policy sessions_api on sessions for all using (true) with check (true);

-- Platform admin reads/updates tenant rows and snapshot metadata (API sets app.platform_admin only for verified admins).
create or replace function app_platform_admin() returns boolean language sql stable as
$$ select coalesce(current_setting('app.platform_admin', true), '') = 'on' $$;
drop policy if exists platform_admin_tenants on tenants;
create policy platform_admin_tenants on tenants for all using (app_platform_admin()) with check (app_platform_admin());
drop policy if exists platform_admin_snapshots on business_snapshots;
create policy platform_admin_snapshots on business_snapshots for select using (app_platform_admin());

create table if not exists security_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references users (id) on delete set null,
  tenant_id uuid references tenants (id) on delete set null,
  action text not null,
  detail jsonb,
  ip text
);
create index if not exists security_events_at_idx on security_events (at desc);
create index if not exists security_events_tenant_idx on security_events (tenant_id, at desc);

grant select, insert on security_events to marginpilot_app;
grant usage on sequence security_events_id_seq to marginpilot_app;
grant update (name, country, currency, status, plan) on tenants to marginpilot_app;
grant update (role) on memberships to marginpilot_app;
grant delete on sessions to marginpilot_app;
