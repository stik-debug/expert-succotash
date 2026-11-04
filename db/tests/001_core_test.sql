-- Plain-SQL integrity tests. Run as a superuser on an EMPTY test database.
-- Fixtures are synthetic and only ever live in this test database.
create temp table _r(name text, ok boolean);
grant all on _r to marginpilot_app;
insert into tenants (id, name) values ('00000000-0000-0000-0000-00000000000a','Tenant A'),('00000000-0000-0000-0000-00000000000b','Tenant B');

set role marginpilot_app;
select set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a',false);
insert into accounts (id, tenant_id, code, name, type) values
 ('10000000-0000-0000-0000-000000000001', app_tenant(), '1000','Cash','asset'),
 ('10000000-0000-0000-0000-000000000002', app_tenant(), '4000','Sales','revenue');

do $$ declare eid uuid; ok boolean; begin
  -- 1 balanced entry posts
  eid := post_entry('2026-11-01','Sale','[{"account_id":"10000000-0000-0000-0000-000000000001","debit":50000,"credit":0},{"account_id":"10000000-0000-0000-0000-000000000002","debit":0,"credit":50000}]');
  insert into _r values ('balanced entry posts', eid is not null);
  -- 2 unbalanced entry rejected (deferred check fires at statement end inside savepoint)
  begin
    perform post_entry('2026-11-01','Bad','[{"account_id":"10000000-0000-0000-0000-000000000001","debit":100,"credit":0},{"account_id":"10000000-0000-0000-0000-000000000002","debit":0,"credit":99}]');
    set constraints all immediate; insert into _r values ('unbalanced rejected', false);
  exception when others then insert into _r values ('unbalanced rejected', true); end;
  -- 3 immutability
  begin update journal_entries set memo='x'; insert into _r values ('update blocked', false);
  exception when others then insert into _r values ('update blocked', true); end;
  begin delete from journal_lines; insert into _r values ('delete blocked', false);
  exception when others then insert into _r values ('delete blocked', true); end;
  -- 4 reversal works once, not twice
  perform reverse_entry(eid,'2026-11-02');
  begin perform reverse_entry(eid,'2026-11-03'); insert into _r values ('double reversal blocked', false);
  exception when others then insert into _r values ('double reversal blocked', true); end;
  -- 5 period lock
  perform lock_period('2026-11-30');
  begin perform post_entry('2026-11-10','Late','[{"account_id":"10000000-0000-0000-0000-000000000001","debit":1,"credit":0},{"account_id":"10000000-0000-0000-0000-000000000002","debit":0,"credit":1}]');
    insert into _r values ('locked period blocked', false);
  exception when others then insert into _r values ('locked period blocked', true); end;
  begin perform lock_period('2026-10-31'); insert into _r values ('reopen needs reason', false);
  exception when others then insert into _r values ('reopen needs reason', true); end;
  -- 6 duplicate receipt per tenant
  insert into payment_confirmations (tenant_id, receipt_no, amount, source) values (app_tenant(),'ABC1234567',500,'statement_import');
  begin insert into payment_confirmations (tenant_id, receipt_no, amount, source) values (app_tenant(),'ABC1234567',500,'statement_import');
    insert into _r values ('duplicate receipt blocked', false);
  exception when unique_violation then insert into _r values ('duplicate receipt blocked', true); end;
end $$;

-- 7 tenant isolation
select set_config('app.tenant_id','00000000-0000-0000-0000-00000000000b',false);
insert into _r select 'tenant B sees no A entries', count(*) = 0 from journal_entries;
insert into _r select 'tenant B sees no A accounts', count(*) = 0 from accounts;
do $$ begin
  begin insert into accounts (tenant_id, code, name, type) values ('00000000-0000-0000-0000-00000000000a','9','x','asset');
    insert into _r values ('cross-tenant insert blocked', false);
  exception when others then insert into _r values ('cross-tenant insert blocked', true); end;
end $$;

reset role;
select name, case when ok then 'PASS' else 'FAIL' end as result from _r order by 1;
do $$ begin if exists (select 1 from _r where not ok) then raise exception 'DB INTEGRITY TESTS FAILED'; end if; end $$;
