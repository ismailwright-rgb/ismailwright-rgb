-- ============================================================================
-- SANAKU - THE REST OF THE CATALOG. RUN THIS ONE FILE.
--
-- Supabase -> SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run more than once. Takes a second or two.
--
-- Requires VOICE-RUN-THIS.sql to have been run already.
--
-- Installs the foundation the unbuilt services need:
--   1. Bundle contents, so 'Complete Lead Recovery' actually grants its four parts
--   2. sanaku_has_addon() - the gate every workflow checks before it acts, so
--      nothing runs for a client who did not buy it (or who cancelled)
--   3. Appointment time, job-completed time, nurture position, and the consent
--      record that makes an outbound call legal
--   4. Per-client agent behaviour (tone, phrases to avoid, service area) and
--      the VAPI assistant id
--   5. The audit trail on change requests, plus a client-safe view of them
--
-- After running, scroll to the bottom for the verification query.
-- ============================================================================


-- ============================================================================
-- Migration 010 - what the rest of the catalog needs to exist
-- Run after migration-009-voice.sql.
--
-- The catalog sells 23 services. Seven have software behind them. This migration
-- lays the foundation for the other sixteen: somewhere to record an appointment,
-- somewhere to record that a job finished, somewhere to record WHY it is legal
-- to contact someone - and a way for a workflow to ask whether this client
-- actually bought the thing it is about to do.
--
-- That last one is the important one. Today nothing in n8n reads
-- sanaku_client_addons at all, so a nurture sequence would happily text the
-- customers of a client who never paid for nurture.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Bundles, expanded.
--
--    'Complete Lead Recovery' is four products sold as one line. A workflow
--    asking "does this client have nurture?" has to get 'yes' from a client who
--    bought the bundle, or the bundle is a promise the software does not keep.
--
--    A table rather than a CASE in the function: the catalog is data, and the
--    next bundle should be an insert, not a code change.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_addon_bundle_members (
  bundle_code text not null references sanaku_addons (code) on delete cascade,
  member_code text not null references sanaku_addons (code) on delete cascade,
  primary key (bundle_code, member_code)
);

alter table sanaku_addon_bundle_members enable row level security;
alter table sanaku_addon_bundle_members force  row level security;
drop policy if exists staff_all   on sanaku_addon_bundle_members;
drop policy if exists client_read on sanaku_addon_bundle_members;
create policy staff_all on sanaku_addon_bundle_members for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
-- Readable by any signed-in client: it is the contents of a package they can
-- see the price of. Nothing here is commercial.
create policy client_read on sanaku_addon_bundle_members for select to authenticated
  using (true);

insert into sanaku_addon_bundle_members (bundle_code, member_code) values
  ('bundle_recovery_home',    'recover_missed_call_home'),
  ('bundle_recovery_home',    'after_hours_intake_home'),
  ('bundle_recovery_home',    'nurture_home'),
  ('bundle_recovery_home',    'reminders_home'),
  ('bundle_recovery_law',     'recover_missed_call_law'),
  ('bundle_recovery_law',     'after_hours_intake_law'),
  ('bundle_recovery_law',     'nurture_law'),
  ('bundle_recovery_law',     'reminders_law'),
  ('bundle_recovery_medical', 'recover_missed_call_medical'),
  ('bundle_recovery_medical', 'after_hours_intake_medical'),
  ('bundle_recovery_medical', 'nurture_medical'),
  ('bundle_recovery_medical', 'reminders_medical')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- 2. The gate.
--
--    Every workflow calls this before it does anything. 'active' only - an
--    add-on that is merely 'requested' or 'approved' has not started, and one
--    that is 'cancelled' must stop the software the same day it stops the
--    invoice.
--
--    security definer so a workflow can ask about a client without holding
--    rights over the whole table.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_has_addon(_client_id uuid, _code text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sanaku_client_addons a
    where a.client_id = _client_id
      and a.status = 'active'
      and (
        a.addon_code = _code
        or exists (
          select 1 from public.sanaku_addon_bundle_members b
          where b.bundle_code = a.addon_code and b.member_code = _code
        )
      )
  )
$$;

revoke execute on function public.sanaku_has_addon(uuid, text) from public, anon;
grant   execute on function public.sanaku_has_addon(uuid, text) to authenticated;
-- The workflows reach PostgREST with the service role, so it needs this
-- explicitly - the revoke above takes it away from everyone by default.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sanaku_has_addon(uuid, text) to service_role;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. What a lead needs before reminders, reviews and nurture can exist.
--
--    consent_source is the one that matters legally. An AI voice is an
--    artificial voice under the TCPA, and calling a mobile without prior
--    express consent runs $500-$1,500 per call - so the callback product may
--    only ever dial someone whose row says how they asked to be contacted.
--    No consent recorded, no call placed.
-- ----------------------------------------------------------------------------
alter table sanaku_client_leads
  add column if not exists scheduled_for      timestamptz,
  add column if not exists completed_at       timestamptz,
  add column if not exists nurture_step       int not null default 0,
  add column if not exists nurture_stopped_at timestamptz,
  add column if not exists consent_source     text,
  add column if not exists consent_at         timestamptz;

alter table sanaku_client_leads
  drop constraint if exists sanaku_client_leads_consent_check;
alter table sanaku_client_leads
  add constraint sanaku_client_leads_consent_check
  check (consent_source is null or consent_source in
         ('web_form', 'inbound_call', 'inbound_sms', 'chat', 'existing_customer'));

-- The scheduled workflows poll these every few minutes. Partial indexes because
-- the overwhelming majority of leads have none of these set.
create index if not exists sanaku_client_leads_scheduled_idx
  on sanaku_client_leads (scheduled_for) where scheduled_for is not null;
create index if not exists sanaku_client_leads_completed_idx
  on sanaku_client_leads (completed_at) where completed_at is not null;
create index if not exists sanaku_client_leads_nurture_idx
  on sanaku_client_leads (client_id, nurture_step, captured_at)
  where nurture_stopped_at is null;

comment on column sanaku_client_leads.consent_source is
  'How this person asked to be contacted. Required before any outbound call or nurture text - it is the record that the contact was invited.';
comment on column sanaku_client_leads.nurture_step is
  'How many nurture touches have been sent. 0 = none. Reset is deliberate: a reply sets nurture_stopped_at instead.';

-- ----------------------------------------------------------------------------
-- 4. Per-client agent behaviour, and where the VAPI assistant lives.
--
--    These feed the assistant prompt. They are ADDITIVE only - the prompt puts
--    them below the safety and pricing rules, so a client can tighten how their
--    agent behaves but cannot switch off "never quote a price" or "gas leak,
--    hang up and call 911".
--
--    vapi_assistant_id is what stops provisioning creating a second assistant
--    every time it runs.
-- ----------------------------------------------------------------------------
alter table sanaku_clients
  add column if not exists service_area      text,
  add column if not exists tone_notes        text,
  add column if not exists never_say         text,
  add column if not exists urgent_definition text,
  add column if not exists callback_promise  text,
  add column if not exists extra_intake      text,
  add column if not exists review_link       text,
  add column if not exists vapi_assistant_id text,
  add column if not exists baa_signed_on     date;

comment on column sanaku_clients.baa_signed_on is
  'Business Associate Agreement date. Medical add-ons carry requires_baa and must not be provisioned until this is set.';
comment on column sanaku_clients.never_say is
  'Client-supplied phrases the agent must avoid. Additive - it cannot remove a rule the base prompt sets.';

-- ----------------------------------------------------------------------------
-- 5. Change requests: the audit trail sanaku_client_addons already has.
--
--    notified_at is the point of the whole thing - without it there is no way
--    to tell "marked done" from "marked done and the client was told".
-- ----------------------------------------------------------------------------
alter table sanaku_change_requests
  add column if not exists staff_note  text,
  add column if not exists notified_at timestamptz,
  add column if not exists decided_by  uuid references auth.users on delete set null;

-- The client reads their own requests. staff_note is for you, not for them, so
-- it must not travel: re-state the client-readable shape as a view rather than
-- letting select=* pick up a column written in private.
create or replace view sanaku_my_requests as
  select id, client_id, submitted_at, request, priority, status, resolved_at, notified_at
  from sanaku_change_requests
  where client_id in (select public.sanaku_my_clients());
alter view sanaku_my_requests set (security_barrier = on);
revoke all on sanaku_my_requests from anon;
grant select on sanaku_my_requests to authenticated;

commit;


-- ============================================================================
-- VERIFY - the gate is the thing worth checking. Expect one row per bundle
-- with 4 members, and the new columns present.
-- ============================================================================
select
  (select count(*) from sanaku_addon_bundle_members)            as bundle_links,   -- expect 12
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_client_leads'
      and column_name in ('scheduled_for','completed_at','nurture_step',
                          'nurture_stopped_at','consent_source','consent_at')
  )                                                             as lead_columns,   -- expect 6
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_clients'
      and column_name in ('service_area','tone_notes','never_say','urgent_definition',
                          'callback_promise','extra_intake','review_link',
                          'vapi_assistant_id','baa_signed_on')
  )                                                             as client_columns, -- expect 9
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_my_requests')                    as client_req_view;-- expect 8

-- What each bundle grants. Every row here is a promise the software now keeps.
select bundle_code, string_agg(member_code, ', ' order by member_code) as grants
from sanaku_addon_bundle_members group by bundle_code order by bundle_code;
