-- MarginPilot migration 006: every cloud save keeps the previous copy, so a bad push or a mistake is always recoverable.
create table if not exists business_snapshot_history (
  id bigserial primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  revision bigint not null,
  payload jsonb not null,
  checksum text not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index if not exists snapshot_history_tenant_idx on business_snapshot_history (tenant_id, id desc);
alter table business_snapshot_history enable row level security;
alter table business_snapshot_history force row level security;
drop policy if exists tenant_isolation on business_snapshot_history;
create policy tenant_isolation on business_snapshot_history using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
grant select, insert, delete on business_snapshot_history to marginpilot_app;
grant usage on sequence business_snapshot_history_id_seq to marginpilot_app;
