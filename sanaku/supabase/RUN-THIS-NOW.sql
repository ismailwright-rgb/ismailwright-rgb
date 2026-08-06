-- ============================================================================
-- SANAKU - RUN THIS NOW
--
-- Everything pending, in the right order, in one paste.
-- Supabase -> SQL Editor -> New query -> paste this whole file -> Run.
--
-- Safe to run more than once. Takes a few seconds.
--
-- Contains:
--   0. Pricing and pilot terms on sanaku_clients, plus the by-vertical fee
--      constraint. It was never in a bundle, so a database built only from
--      these files was missing per_lead_monthly_cap and the statement
--      function could not be created at all.
--   1. CRM tables (notes, follow-ups)
--   2. SECURITY FIX - closes two holes that are open right now
--   3. T1 Missed-Call Text-Back support
--   4. Client logo storage (white-label branding)
--
-- After running, scroll to the very bottom of this file for the two
-- verification queries.
-- ============================================================================


-- ==========================================================================
-- SECTION: migration-002-pricing.sql
-- ==========================================================================
-- ============================================================================
-- Migration 002 - pricing and pilot terms
-- Run in the Supabase SQL editor. Idempotent - safe to re-run.
-- ============================================================================

alter table sanaku_clients
  add column if not exists setup_fee          numeric,
  add column if not exists pilot_ends_on      date,     -- free-service window end
  add column if not exists billing_starts_on  date,     -- first retainer charge
  add column if not exists agreement_signed_on date,
  add column if not exists notes              text;

-- Per-lead billing needs a definition of "qualified" agreed up front, and a
-- ceiling so the client can predict their bill.
alter table sanaku_clients
  add column if not exists qualified_definition text,
  add column if not exists per_lead_monthly_cap numeric;

-- ----------------------------------------------------------------------------
-- Guardrail: fee structures that are legally problematic by vertical.
--   medical      -> flat fee ONLY (anti-kickback / fee-splitting exposure)
--   law_firm     -> flat, or retainer + per-lead DELIVERED. Never a share of
--                   fees (ABA Model Rule 5.4 - non-lawyer fee splitting)
--   home_services-> anything, including revenue share
-- Enforced in the database so a late-night onboarding cannot create a
-- structure that a client's counsel would later kill.
-- ----------------------------------------------------------------------------
alter table sanaku_clients drop constraint if exists sanaku_clients_pricing_legal;
alter table sanaku_clients add constraint sanaku_clients_pricing_legal check (
  vertical is null
  or pricing_model is null
  or (vertical = 'medical'       and pricing_model = 'flat')
  or (vertical = 'law_firm'      and pricing_model in ('flat', 'retainer_plus_per_lead'))
  or (vertical = 'home_services')
);

comment on constraint sanaku_clients_pricing_legal on sanaku_clients is
  'Healthcare: flat fee only. Law firms: no revenue share (fee-splitting rules). Home services: unrestricted.';

-- ----------------------------------------------------------------------------
-- What a client owes for a period, computed from the lead meter rather than
-- from anything the client self-reports.
--
-- migration-013 replaces this with a wider return type, and Postgres will not
-- let CREATE OR REPLACE change a return type in place - it raises and aborts
-- the whole paste. So on any re-run of the bundles this file would kill
-- RUN-THIS-NOW.sql before it reached the CRM tables. Skipping when the
-- function already exists is the only option that is safe in every order:
-- dropping it first would silently drag a newer definition backwards.
-- ----------------------------------------------------------------------------
do $guard$
begin
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'sanaku_period_due'
  ) then
    raise notice 'sanaku_period_due already exists - leaving it to the later migration';
    return;
  end if;
  execute $fn$
create function sanaku_period_due(_client_id uuid, _from date, _to date)
returns table (
  leads_captured   int,
  qualified_leads  int,
  after_hours      int,
  retainer_due     numeric,
  per_lead_due     numeric,
  total_due        numeric
)
language sql stable as $$
  with c as (select * from sanaku_clients where id = _client_id),
  l as (
    select *
    from sanaku_client_leads
    where client_id = _client_id
      and billable = true
      and captured_at >= _from
      and captured_at < (_to + 1)
  )
  select
    (select count(*) from l)::int,
    (select count(*) from l where qualified)::int,
    (select count(*) from l where after_hours)::int,
    coalesce((select monthly_retainer from c), 0),
    least(
      coalesce((select per_lead_fee from c), 0) * (select count(*) from l where qualified),
      coalesce((select per_lead_monthly_cap from c), 1e9)
    ),
    coalesce((select monthly_retainer from c), 0) +
    least(
      coalesce((select per_lead_fee from c), 0) * (select count(*) from l where qualified),
      coalesce((select per_lead_monthly_cap from c), 1e9)
    )
$$;
  $fn$;
end $guard$;

-- Usage:  select * from sanaku_period_due('<client-uuid>', '2026-08-01', '2026-08-31');


-- ==========================================================================
-- SECTION: migration-003-crm.sql
-- ==========================================================================
-- ============================================================================
-- Migration 003 - CRM layer: notes, activity tracking, follow-ups
-- Run in the Supabase SQL editor. Idempotent - safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Timestamped notes on a prospect. (prospects.notes stays as the free-text
-- field the scraper and imports write into; this is the human record.)
-- ----------------------------------------------------------------------------
create table if not exists sanaku_notes (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid references sanaku_prospects (id) on delete cascade,
  body        text not null,
  author      text,
  created_at  timestamptz not null default now()
);

create index if not exists sanaku_notes_prospect_idx
  on sanaku_notes (prospect_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Follow-up tracking on prospects
-- ----------------------------------------------------------------------------
alter table sanaku_prospects
  add column if not exists next_action      text,
  add column if not exists next_action_at   timestamptz,
  add column if not exists last_activity_at timestamptz;

create index if not exists sanaku_prospects_next_action_idx
  on sanaku_prospects (next_action_at) where next_action_at is not null;

-- ----------------------------------------------------------------------------
-- Any conversation or note touches the prospect's activity clock, so "who has
-- gone quiet" is answerable without scanning child tables.
-- ----------------------------------------------------------------------------
create or replace function sanaku_touch_activity() returns trigger
language plpgsql as $$
begin
  update sanaku_prospects
     set last_activity_at = greatest(coalesce(last_activity_at, to_timestamp(0)), now())
   where id = new.prospect_id;
  return new;
end;
$$;

drop trigger if exists sanaku_conversations_touch on sanaku_conversations;
create trigger sanaku_conversations_touch
  after insert on sanaku_conversations
  for each row execute function sanaku_touch_activity();

drop trigger if exists sanaku_notes_touch on sanaku_notes;
create trigger sanaku_notes_touch
  after insert on sanaku_notes
  for each row execute function sanaku_touch_activity();

-- ----------------------------------------------------------------------------
-- What needs working today. Excludes finished and suppressed records.
-- ----------------------------------------------------------------------------
-- DROP, not CREATE OR REPLACE. migration-017 widens this view, and on any
-- re-run of the bundles this statement then tries to shrink it back -
-- "cannot drop columns from view" aborts RUN-THIS-NOW.sql here. Dropping
-- first is safe in either order; migration-004's loop restores
-- security_invoker further down this same file.
drop view if exists v_followups_due;
create view v_followups_due as
select
  id, company_name, vertical, tier, intent_score, status,
  contact_name, contact_phone, contact_email,
  next_action, next_action_at, last_activity_at
from sanaku_prospects
where next_action_at is not null
  and next_action_at <= now()
  and do_not_contact = false
  and status not in ('won', 'lost', 'dnc')
order by next_action_at asc;

-- RLS on, no policy here: migration-004-security.sql installs the staff-only
-- policy. A permissive policy in this file would be re-applied on any re-run
-- and re-open the table to client-portal users.
alter table sanaku_notes enable row level security;
alter table sanaku_notes force  row level security;
drop policy if exists owner_all on sanaku_notes;


-- ==========================================================================
-- SECTION: migration-004-security.sql
-- ==========================================================================
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


-- ==========================================================================
-- SECTION: migration-005-t1.sql
-- ==========================================================================
-- ============================================================================
-- Migration 005 - T1 Missed-Call Text-Back
-- Run after migration-004-security.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Per-client operating parameters for the deployed workflow.
-- business_hours drives the after_hours flag - the number that renews
-- contracts ("37 of the 84 leads we caught came in while you were closed").
-- ----------------------------------------------------------------------------
alter table sanaku_clients
  add column if not exists timezone          text not null default 'America/Los_Angeles',
  add column if not exists business_hours    jsonb not null default
    '{"mon":["08:00","17:00"],"tue":["08:00","17:00"],"wed":["08:00","17:00"],"thu":["08:00","17:00"],"fri":["08:00","17:00"],"sat":null,"sun":null}'::jsonb,
  add column if not exists textback_message  text,
  add column if not exists escalation_phone  text,
  add column if not exists escalation_email  text,
  add column if not exists inbound_number    text;   -- the number customers dial

create index if not exists sanaku_clients_inbound_idx on sanaku_clients (inbound_number);

comment on column sanaku_clients.textback_message is
  'First text sent after a missed call. {brand} is substituted. Falls back to a default if null.';

-- ----------------------------------------------------------------------------
-- Per-client opt-out list. A STOP from a customer must be permanent and must
-- never bleed across clients.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_client_suppression (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references sanaku_clients (id) on delete cascade,
  phone      text not null,
  reason     text,
  created_at timestamptz not null default now(),
  unique (client_id, phone)
);

alter table sanaku_client_suppression enable row level security;
alter table sanaku_client_suppression force  row level security;
drop policy if exists staff_all on sanaku_client_suppression;
create policy staff_all on sanaku_client_suppression for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- Lead lifecycle fields for the text conversation.
-- ----------------------------------------------------------------------------
alter table sanaku_client_leads
  add column if not exists conversation   jsonb not null default '[]'::jsonb,
  add column if not exists last_message_at timestamptz,
  add column if not exists provider_sid   text;

create index if not exists sanaku_client_leads_phone_idx on sanaku_client_leads (client_id, phone);

-- ----------------------------------------------------------------------------
-- Is a given moment inside this client's business hours?
-- Used to set after_hours at capture time.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_is_after_hours(_client_id uuid, _at timestamptz default now())
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  _tz    text;
  _hours jsonb;
  _local timestamptz;
  _dow   text;
  _span  jsonb;
  _t     time;
begin
  select c.timezone, c.business_hours into _tz, _hours
  from public.sanaku_clients c where c.id = _client_id;
  if _tz is null then return true; end if;              -- unknown client: treat as after hours

  _local := _at at time zone _tz;
  _dow   := lower(to_char(_at at time zone _tz, 'dy'));
  _span  := _hours -> _dow;
  if _span is null or jsonb_typeof(_span) = 'null' then
    return true;                                        -- closed that day
  end if;
  _t := (_at at time zone _tz)::time;
  return not (_t >= (_span ->> 0)::time and _t < (_span ->> 1)::time);
end $$;

revoke execute on function public.sanaku_is_after_hours(uuid, timestamptz) from public, anon;
grant   execute on function public.sanaku_is_after_hours(uuid, timestamptz) to authenticated;

commit;


-- ==========================================================================
-- SECTION: migration-006-branding.sql
-- ==========================================================================
-- ============================================================================
-- Migration 006 - client logo storage
-- Run after migration-004-security.sql.
--
-- Logos live in a PUBLIC bucket: a client's portal renders the image in their
-- browser, and portal users have no storage credentials. Public read is fine -
-- a logo is a public asset by nature - but only staff may write.
-- ============================================================================

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-logos', 'client-logos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

-- Anyone may read (the client's browser fetches it unauthenticated);
-- only staff may add, replace or remove.
drop policy if exists "client logos are publicly readable" on storage.objects;
create policy "client logos are publicly readable" on storage.objects
  for select using (bucket_id = 'client-logos');

drop policy if exists "staff manage client logos" on storage.objects;
create policy "staff manage client logos" on storage.objects
  for all to authenticated
  using (bucket_id = 'client-logos' and (select public.sanaku_is_staff()))
  with check (bucket_id = 'client-logos' and (select public.sanaku_is_staff()));

commit;


-- ============================================================================
-- VERIFY - run these AFTER the above finishes.
--
-- The SQL Editor shows only the LAST statement's result, so run them one at
-- a time: select the query text, then Run.
--
-- Do NOT verify with `select public.sanaku_is_staff()` here. That function
-- answers "is the CURRENT LOGGED-IN USER staff?" - and the SQL Editor runs
-- as the database owner, with no logged-in user, so auth.uid() is null and
-- the answer is always false. It proves nothing. Query the table instead.
-- ============================================================================

-- (a) Every account, and whether it is seeded as staff.
--     YOUR email must show seeded_as_staff = true.
select u.email,
       (s.user_id is not null) as seeded_as_staff
from auth.users u
left join public.sanaku_staff s on s.user_id = u.id
order by u.created_at;

-- (b) Every table must have row level security. This must return ZERO rows:
select relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

-- (c) Nothing may be readable by an anonymous visitor.
--     This must also return ZERO rows:
select tablename, policyname
from pg_policies
where schemaname = 'public' and 'anon' = any (roles);
