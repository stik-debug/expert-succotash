-- MarginPilot core schema (Phase 1). PostgreSQL 15+.
-- Money is bigint minor units (cents). Every tenant table has RLS forced.
-- STATUS: written but NOT yet executed against a live database. Run `npm run test:db`.
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'marginpilot_app') then
    create role marginpilot_app nologin; -- the API connects as a login role that is a member of this
  end if;
end $$;

create function app_tenant() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country char(2) not null default 'KE',
  currency char(3) not null default 'KES',
  locked_through date,                       -- accounting period lock
  created_at timestamptz not null default now()
);
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null, password_hash text not null, mfa_secret_enc bytea,
  created_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create table memberships (
  tenant_id uuid not null references tenants,
  user_id uuid not null references users,
  role text not null check (role in ('owner','administrator','branch_manager','accountant','cashier','stock_manager','salesperson','custom')),
  primary key (tenant_id, user_id)
);
create table accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants,
  code text not null, name text not null,
  type text not null check (type in ('asset','liability','equity','revenue','expense')),
  unique (tenant_id, code), unique (tenant_id, id)
);
create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants,
  entry_date date not null, memo text not null,
  reverses_id uuid, posted_by uuid references users,
  posted_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, reverses_id),           -- an entry can be reversed once
  foreign key (tenant_id, reverses_id) references journal_entries (tenant_id, id)
);
create table journal_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants,
  entry_id uuid not null, account_id uuid not null,
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  check ((debit > 0) <> (credit > 0)),
  foreign key (tenant_id, entry_id) references journal_entries (tenant_id, id),
  foreign key (tenant_id, account_id) references accounts (tenant_id, id)
);
create index on journal_lines (tenant_id, account_id);
create table audit_log (
  id bigserial primary key, tenant_id uuid, actor uuid,
  action text not null, detail jsonb, at timestamptz not null default now()
);

-- M-Pesa without Daraja: confirmations come from statement import (or C2B later)
create table payment_confirmations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants,
  receipt_no text not null, amount bigint not null check (amount > 0),
  received_at timestamptz, source text not null check (source in ('statement_import','c2b')),
  created_at timestamptz not null default now(),
  unique (tenant_id, receipt_no)
);
create table sale_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants,
  sale_ref text not null, method text not null check (method in ('cash','mpesa','bank','card')),
  amount bigint not null check (amount > 0),
  claimed_receipt_no text, source text check (source in ('manual','shared_sms','pasted_sms')),
  parser_version text,
  confidence text not null default 'unconfirmed' check (confidence in ('unconfirmed','attested','verified','flagged')),
  created_at timestamptz not null default now()
);
create unique index sale_payments_receipt_uq on sale_payments (tenant_id, claimed_receipt_no) where claimed_receipt_no is not null;

-- Plans are data, so prices and limits change without a deploy. Prices never rewrite history.
create table plans (code text primary key, name text not null, active boolean not null default true,
  limits jsonb not null default '{}', features jsonb not null default '{}');
create table plan_prices (
  id bigserial primary key, plan_code text not null references plans,
  amount bigint not null check (amount >= 0), currency char(3) not null default 'KES',
  interval text not null default 'month', effective_from date not null default current_date
);
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants, plan_code text not null references plans,
  status text not null check (status in ('trial','active','past_due','suspended','cancelled')),
  current_period_end date, grace_until date, created_at timestamptz not null default now()
);
create table subscription_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants, subscription_id uuid not null references subscriptions,
  amount bigint not null check (amount > 0), mpesa_receipt_no text not null unique,
  verified_at timestamptz not null, created_at timestamptz not null default now()
);
insert into plans (code, name, limits) values
  ('small_shop','Small Shop','{"branches":1,"users":2}'),
  ('big_business','Big Business','{"branches":10,"users":25}');
insert into plan_prices (plan_code, amount) values ('small_shop', 10000), ('big_business', 25000);

-- ---------- Integrity triggers ----------
create function forbid_change() returns trigger language plpgsql as
$$ begin raise exception 'Posted records are immutable; post a reversal instead'; end $$;
create trigger je_immutable before update or delete on journal_entries for each row execute function forbid_change();
create trigger jl_immutable before update or delete on journal_lines for each row execute function forbid_change();
create trigger audit_immutable before update or delete on audit_log for each row execute function forbid_change();

create function check_period() returns trigger language plpgsql as $$
declare lt date; begin
  select locked_through into lt from tenants where id = new.tenant_id;
  if lt is not null and new.entry_date <= lt then
    raise exception 'Accounting period is locked through %', lt; end if;
  return new; end $$;
create trigger je_period before insert on journal_entries for each row execute function check_period();

create function check_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint; n int; begin
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n
    from journal_lines where tenant_id = new.tenant_id and entry_id = new.entry_id;
  if d <> c or n < 2 then raise exception 'Journal entry % is not balanced (debit %, credit %)', new.entry_id, d, c; end if;
  return null; end $$;
create constraint trigger jl_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function check_balanced();

-- Lock changes and reopening are audited; moving the lock back requires a reason.
create function lock_period(p_date date, p_reason text default null) returns void language plpgsql as $$
declare cur date; begin
  select locked_through into cur from tenants where id = app_tenant();
  if cur is not null and p_date < cur and coalesce(p_reason,'') = '' then
    raise exception 'Reopening a locked period requires a reason'; end if;
  update tenants set locked_through = p_date where id = app_tenant();
  insert into audit_log (tenant_id, action, detail)
    values (app_tenant(), case when cur is not null and p_date < cur then 'period_reopened' else 'period_locked' end,
            jsonb_build_object('from', cur, 'to', p_date, 'reason', p_reason));
end $$;

-- Posting API: lines = [{"account_id":"...","debit":100,"credit":0}, ...]
create function post_entry(p_date date, p_memo text, p_lines jsonb, p_user uuid default null, p_reverses uuid default null)
returns uuid language plpgsql as $$
declare eid uuid; l jsonb; begin
  insert into journal_entries (tenant_id, entry_date, memo, posted_by, reverses_id)
    values (app_tenant(), p_date, p_memo, p_user, p_reverses) returning id into eid;
  for l in select * from jsonb_array_elements(p_lines) loop
    insert into journal_lines (tenant_id, entry_id, account_id, debit, credit)
      values (app_tenant(), eid, (l->>'account_id')::uuid, (l->>'debit')::bigint, (l->>'credit')::bigint);
  end loop;
  return eid; end $$;

create function reverse_entry(p_entry uuid, p_date date, p_user uuid default null) returns uuid language plpgsql as $$
declare lines jsonb; memo text; begin
  select e.memo into memo from journal_entries e where e.id = p_entry and e.tenant_id = app_tenant();
  if memo is null then raise exception 'Entry not found'; end if;
  select jsonb_agg(jsonb_build_object('account_id', account_id, 'debit', credit, 'credit', debit))
    into lines from journal_lines where entry_id = p_entry and tenant_id = app_tenant();
  return post_entry(p_date, 'Reversal of: ' || memo, lines, p_user, p_entry);
end $$;

-- ---------- Row-level security ----------
do $$ declare t text; begin
  foreach t in array array['accounts','journal_entries','journal_lines','payment_confirmations','sale_payments','subscriptions','subscription_payments','memberships'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = app_tenant()) with check (tenant_id = app_tenant())', t);
  end loop;
  alter table tenants enable row level security; alter table tenants force row level security;
  create policy tenant_isolation on tenants using (id = app_tenant()) with check (id = app_tenant());
  alter table audit_log enable row level security; alter table audit_log force row level security;
  create policy tenant_isolation on audit_log using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
end $$;

grant usage on schema public to marginpilot_app;
grant select on plans, plan_prices to marginpilot_app;
grant select, insert on journal_entries, journal_lines, audit_log, payment_confirmations, sale_payments, accounts, subscriptions, subscription_payments to marginpilot_app;
grant select, update (locked_through) on tenants to marginpilot_app;
grant select on memberships to marginpilot_app;
grant usage on sequence audit_log_id_seq to marginpilot_app;
