-- ============================================================================
-- Migration 004 - SECURITY HARDENING + multi-tenant foundation
--
-- RUN THIS BEFORE creating any client user account.
--
-- Fixes two live exposures and installs the staff/client model the portal
-- needs. Run the whole file in one go (it is a single transaction).
--
--   1. VIEWS BYPASS RLS. A view created in the SQL editor is owned by postgres
--      and runs with the owner's rights, so v_top_prospects served the entire
--      Tier-1 pipeline (emails, phones, signals) to anyone with a login -
--      regardless of the policies on the base table. Fixed with
--      security_invoker, which every future view must also set.
--   2. The legacy prospect-tiering tables (prospects, suppression_list,
--      error_log, api_usage, outreach_log) were created with NO row level
--      security. Supabase grants anon and authenticated full CRUD on new
--      public tables by default, so the anon key alone - no login at all -
--      could read and write them, including the GDPR suppression list.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. Staff first, or we lock ourselves out when the permissive policies go.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_staff (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists sanaku_client_users (
  user_id    uuid not null references auth.users on delete cascade,
  client_id  uuid not null references sanaku_clients (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index if not exists sanaku_client_users_client_idx on sanaku_client_users (client_id);

-- Everyone who exists today is the operator; client users come later via invite.
insert into sanaku_staff (user_id)
select id from auth.users
where id not in (select user_id from sanaku_client_users)
on conflict do nothing;

do $$ begin
  if not exists (select 1 from sanaku_staff) then
    raise exception 'No staff seeded - aborting rather than locking you out. Create your dashboard login first.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1. Helper predicates.
--    search_path = '' (NOT 'public'): with 'public', an unqualified auth.uid()
--    fails to resolve and every policy errors closed - the app goes dark.
--    Empty path + fully-qualified names is what actually prevents shadowing.
--    Zero-argument by design: a uid parameter would turn these into a
--    cross-tenant oracle callable by any authenticated user.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sanaku_staff s where s.user_id = (select auth.uid()))
$$;

create or replace function public.sanaku_my_clients() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cu.client_id from public.sanaku_client_users cu where cu.user_id = (select auth.uid())
$$;

-- EXECUTE is granted to PUBLIC by default - without this, anon can call them.
revoke execute on function public.sanaku_is_staff() from public, anon;
revoke execute on function public.sanaku_my_clients() from public, anon;
grant execute on function public.sanaku_is_staff() to authenticated;
grant execute on function public.sanaku_my_clients() to authenticated;

-- Billing helper must stay security INVOKER; as definer it becomes a
-- cross-tenant billing oracle.
do $$ begin
  if to_regprocedure('public.sanaku_period_due(uuid,date,date)') is not null then
    revoke execute on function public.sanaku_period_due(uuid,date,date) from public, anon;
    grant execute on function public.sanaku_period_due(uuid,date,date) to authenticated;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2. Drop the permissive policies. These were `using (true)` for every
--    authenticated user - harmless with one operator, total exposure the
--    moment a client can log in.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'sanaku_prospects', 'sanaku_conversations', 'sanaku_demos', 'sanaku_clients',
    'sanaku_client_leads', 'sanaku_change_requests', 'sanaku_billing',
    'sanaku_errors', 'sanaku_notes'
  ] loop
    if to_regclass(t) is not null then
      execute format('drop policy if exists owner_all on %I', t);
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force row level security', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Staff-only tables. Clients never see the prospect pipeline.
--    (select sanaku_is_staff()) - the subselect makes it evaluate once per
--    query rather than once per row.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sanaku_prospects', 'sanaku_conversations', 'sanaku_demos', 'sanaku_errors', 'sanaku_notes'] loop
    if to_regclass(t) is not null then
      execute format('drop policy if exists staff_all on %I', t);
      execute format(
        'create policy staff_all on %I for all to authenticated
           using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()))', t);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 4. sanaku_clients: staff only at the table level. Clients read a filtered
--    VIEW instead - a row-level policy would hand them every column, including
--    monthly_retainer, per_lead_fee, rev_share_pct and setup_fee. Column
--    grants cannot help: staff and clients are both the `authenticated` role.
-- ----------------------------------------------------------------------------
drop policy if exists staff_all on sanaku_clients;
create policy staff_all on sanaku_clients for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));

create or replace view sanaku_my_client as
  select id, company_name, vertical, status, onboarded_at,
         brand_name, brand_logo_url, brand_primary_color, brand_accent_color,
         sending_number, workflow_enabled
  from sanaku_clients
  where id in (select public.sanaku_my_clients());
-- Deliberately owner-rights: the WHERE clause IS the tenant check.
alter view sanaku_my_client set (security_barrier = on);
revoke all on sanaku_my_client from anon;
grant select on sanaku_my_client to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Client-readable data, scoped to their own client_id.
-- ----------------------------------------------------------------------------
drop policy if exists staff_all    on sanaku_client_leads;
drop policy if exists client_read  on sanaku_client_leads;
create policy staff_all on sanaku_client_leads for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
create policy client_read on sanaku_client_leads for select to authenticated
  using (client_id in (select public.sanaku_my_clients()));

drop policy if exists staff_all   on sanaku_billing;
drop policy if exists client_read on sanaku_billing;
create policy staff_all on sanaku_billing for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
create policy client_read on sanaku_billing for select to authenticated
  using (client_id in (select public.sanaku_my_clients()));

-- ----------------------------------------------------------------------------
-- 6. Change requests: clients may file and read their own, never resolve them.
--    The trigger - not the policy - is what pins id/submitted_at/status, since
--    those columns are otherwise client-settable through PostgREST.
-- ----------------------------------------------------------------------------
alter table sanaku_change_requests
  alter column client_id set not null,
  alter column request   set not null;
update sanaku_change_requests set status = 'open' where status is null;
alter table sanaku_change_requests alter column status set not null;

create or replace function public.sanaku_cr_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not public.sanaku_is_staff() then
    new.id           := gen_random_uuid();
    new.submitted_at := now();
    new.status       := 'open';
    new.resolved_at  := null;
  end if;
  return new;
end $$;

drop trigger if exists sanaku_cr_guard_bi on sanaku_change_requests;
create trigger sanaku_cr_guard_bi before insert on sanaku_change_requests
  for each row execute function public.sanaku_cr_guard();

drop policy if exists staff_all     on sanaku_change_requests;
drop policy if exists client_read   on sanaku_change_requests;
drop policy if exists client_insert on sanaku_change_requests;
create policy staff_all on sanaku_change_requests for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
create policy client_read on sanaku_change_requests for select to authenticated
  using (client_id in (select public.sanaku_my_clients()));
-- No UPDATE policy for clients on purpose: adding one would also let them
-- flip status to 'done' via PostgREST upsert (on_conflict + merge-duplicates).
create policy client_insert on sanaku_change_requests for insert to authenticated
  with check (client_id in (select public.sanaku_my_clients())
              and status = 'open' and resolved_at is null);

-- ----------------------------------------------------------------------------
-- 7. The membership tables themselves: deny by default. sanaku_client_users
--    would otherwise enumerate every client_id in the business.
-- ----------------------------------------------------------------------------
alter table sanaku_staff        enable row level security;
alter table sanaku_staff        force  row level security;
alter table sanaku_client_users enable row level security;
alter table sanaku_client_users force  row level security;
revoke all on sanaku_staff, sanaku_client_users from anon;

drop policy if exists staff_read   on sanaku_staff;
drop policy if exists staff_manage on sanaku_client_users;
create policy staff_read on sanaku_staff for select to authenticated
  using ((select public.sanaku_is_staff()));
create policy staff_manage on sanaku_client_users for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- 8. EVERY view runs with owner rights unless told otherwise - that is an RLS
--    bypass. sanaku_my_client above is the one intentional exception.
-- ----------------------------------------------------------------------------
do $$
declare v text;
begin
  foreach v in array array['v_top_prospects', 'tier1_prospects', 'v_followups_due'] loop
    if to_regclass(v) is not null then
      execute format('alter view %I set (security_invoker = on)', v);
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 9. Legacy prospect-tiering tables shipped with no RLS at all, which means the
--    public anon key could read and write them without logging in.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['prospects', 'suppression_list', 'error_log', 'api_usage', 'outreach_log'] loop
    if to_regclass(t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('alter table %I force  row level security', t);
      execute format('revoke all on %I from anon, authenticated', t);
      execute format('drop policy if exists staff_all on %I', t);
      execute format(
        'create policy staff_all on %I for all to authenticated
           using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()))', t);
    end if;
  end loop;
end $$;

commit;

-- ============================================================================
-- VERIFY - both queries must return zero rows.
-- ============================================================================
-- Tables without RLS:
--   select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
--
-- Views that still run with owner rights (each must show security_invoker=true,
-- except sanaku_my_client which is intentionally owner-rights + security_barrier):
--   select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'v';
--
-- And confirm you are still staff (should return true):
--   select public.sanaku_is_staff();
-- ============================================================================
