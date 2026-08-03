-- ============================================================================
-- SANAKU - THE REST OF THE CATALOG. RUN THIS ONE FILE.
--
-- Supabase -> SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run more than once. Takes a second or two.
--
-- Requires VOICE-RUN-THIS.sql to have been run already.
--
--   010  The gate every workflow checks before it acts (sanaku_has_addon), the
--        bundle contents behind it, appointment and job-completed times, the
--        consent record that makes an outbound call lawful, per-client agent
--        behaviour, and a client-safe view of change requests.
--   011  build_status: which of the 23 services actually have software.
--   012  The five bundles that were missing, including the whole voice line.
--
-- After running, scroll to the bottom for the verification queries.
-- ============================================================================


-- ####################  migration-010-services.sql  ####################

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

-- ####################  migration-011-catalog-status.sql  ####################

-- ============================================================================
-- Migration 011 - which of these services actually run
-- Run after migration-010-services.sql.
--
-- The catalog sells 23 services. Seven of them have software behind them today.
-- That fact currently lives nowhere, which is how a sell sheet ends up quoting a
-- monthly fee for something that cannot be delivered, and how the onboarding
-- wizard ends up offering a tick-box that provisions nothing.
--
-- One column, three readers: the sell sheet marks each row, the onboarding
-- wizard offers only what it can provision, and the client portal stops
-- inviting requests for things that do not exist yet.
--
-- What the values mean:
--   live      the workflow exists in this repo and can be turned on for a
--             client today. Not "deployed for someone" - deliverable.
--   in_build  implementation is underway and planned.
--   planned   sold in the catalog, nothing written yet.
--
-- 'live' deliberately says nothing about compliance. requires_baa is a separate
-- column and a separate gate: after_hours_intake_medical is live software that
-- must not be switched on without a signed BAA.
-- ============================================================================

begin;

alter table sanaku_addons
  add column if not exists build_status text not null default 'planned';

alter table sanaku_addons drop constraint if exists sanaku_addons_build_status_check;
alter table sanaku_addons add constraint sanaku_addons_build_status_check
  check (build_status in ('live', 'in_build', 'planned'));

comment on column sanaku_addons.build_status is
  'Whether software exists to deliver this. live = deliverable today. Says nothing about compliance - see requires_baa.';

-- ----------------------------------------------------------------------------
-- What runs today.
--
--   T1 (t1-missed-call-textback + t1-reply-handler) is vertical-agnostic - it
--   reads the client row - so all three missed-call rows are covered.
--   T2 + vapi/assistant-home-services.json covers home services only; the law
--   and medical agents need their own prompts, which do not exist yet.
--   T3 (t3-web-form-intake) covers all three after-hours intake rows.
-- ----------------------------------------------------------------------------
update sanaku_addons set build_status = 'live' where code in (
  'recover_missed_call_home', 'recover_missed_call_law', 'recover_missed_call_medical',
  'voice_reception_home',
  'after_hours_intake_home', 'after_hours_intake_law', 'after_hours_intake_medical'
);

-- Everything else is in flight under the approved build: T4 callback, T5
-- nurture, T6 reminders, T7 review requests, and the four config-only services
-- (the law and medical voice prompts, the after-hours gate, Spanish).
update sanaku_addons set build_status = 'in_build' where code in (
  'voice_callback_home', 'voice_callback_law',
  'nurture_home', 'nurture_law', 'nurture_medical',
  'reminders_home', 'reminders_law', 'reminders_medical',
  'sms_reviews',
  'voice_reception_law', 'voice_reception_medical',
  'voice_afterhours', 'voice_spanish'
);

-- ----------------------------------------------------------------------------
-- A bundle is only as deliverable as its least-finished part.
--
-- Derived rather than typed: hardcoding a bundle as 'live' is exactly the drift
-- this column exists to stop. Recovery contains nurture and reminders, so all
-- three recovery bundles are in_build until those ship.
--
-- To be clear about how this maintains itself: you move a member between the
-- two lists above and the bundle follows on the next run. It does not notice a
-- member shipping on its own - the lists above are the declaration of truth,
-- and re-running resets anything edited directly in the table.
-- ----------------------------------------------------------------------------
update sanaku_addons b set build_status = (
  select case
    when bool_and(m.build_status = 'live')     then 'live'
    when bool_or (m.build_status = 'planned')  then 'planned'
    else 'in_build'
  end
  from sanaku_addon_bundle_members bm
  join sanaku_addons m on m.code = bm.member_code
  where bm.bundle_code = b.code
)
where b.category = 'bundle'
  and exists (select 1 from sanaku_addon_bundle_members bm where bm.bundle_code = b.code);

commit;

-- ####################  migration-012-bundles.sql  ####################

-- ============================================================================
-- Migration 012 - the bundles that were missing
-- Run after migration-011-catalog-status.sql.
--
-- Every package in the catalog was recovery-only, which left the voice line -
-- the most expensive thing sold, $750 to $1,500 setup - with no discount path
-- at all. These five fill that in.
--
-- Priced the same way the three recovery bundles were: off the a-la-carte sum,
-- 27-29% off setup and 21-25% off monthly. That band is not invented here, it
-- is measured from what already exists (home 31/24, law 30/27, medical 26/21).
--
-- Two rules held while pricing:
--
--   1. No bundle contains both voice_afterhours and a full voice_reception_*.
--      After-hours answering IS the phone agent restricted to closed hours.
--      Selling both in one package charges twice for one thing.
--
--   2. The complete tiers are priced off the a-la-carte sum, never off the
--      recovery bundle price. Discounting an already-discounted number
--      compounds, and the second discount is invisible on the invoice.
--
-- KNOWN LIMITATION, deliberately not papered over: a bundle spanning voice and
-- messaging has two allowances - voice minutes and texts - and this schema has
-- one (included_minutes + unit_label). The complete tiers therefore carry their
-- VOICE minutes in that column and state the text allowance in detail. Nothing
-- meters usage automatically today (the columns are read only for display in
-- AddOns.jsx and AddOnRequests.jsx), so this costs nothing right now. If
-- metering is ever automated, add included_texts / overage_per_text before
-- selling these at volume.
-- ============================================================================

begin;

insert into sanaku_addons
  (code, name, blurb, detail, category, allowed_verticals, setup_fee, monthly_fee,
   included_minutes, overage_per_minute, per_lead_fee, requires_baa, compliance_note,
   sort, unit_label, build_status)
values

-- -- Voice bundles ----------------------------------------------------------
-- The gap. Reception + callback + Spanish, which is the natural set: the agent
-- that answers, the agent that calls back, and the language half your callers
-- may speak.
('bundle_voice_home', 'Complete Phone Cover',
 'Every call answered, every web enquiry called back, in English or Spanish.',
 'The AI phone agent, instant lead callback, and the Spanish-speaking agent, set up together. Bought separately these are $1,500 setup and $700/month.',
 'bundle', array['home_services'], 1100, 550, 700, 0.45, 20, false,
 'Callers are told they are speaking with an automated assistant and that the call is recorded. Callbacks go only to people who just contacted you, about the thing they contacted you about.',
 4, 'minutes', 'in_build'),

('bundle_voice_law', 'Complete Phone Cover',
 'Every call answered and every web enquiry called back, with first-pass intake.',
 'The AI intake agent, instant lead callback, and the Spanish-speaking agent, set up together. Bought separately these are $2,750 setup and $1,200/month.',
 'bundle', array['law_firm'], 2000, 900, 700, 0.55, 35, false,
 'The agent states it is not a lawyer and gives no legal advice or fee quotes. Per-lead is per intake delivered, never per case signed - a share of fees would be fee-splitting with a non-lawyer.',
 4, 'minutes', 'in_build'),

-- -- Everything tiers -------------------------------------------------------
-- Priced off the a-la-carte sum of all parts, not off the bundles inside them.
('bundle_complete_home', 'The Whole System',
 'Nothing that rings, texts, or fills in a form gets missed.',
 'Missed-call text-back, after-hours intake, five-touch nurture, reminders with no-show recovery, the AI phone agent, instant callback, the Spanish-speaking agent, and review requests. Bought separately these are $3,500 setup and $1,650/month. Includes 700 voice minutes and 500 texts a month.',
 'bundle', array['home_services'], 2500, 1250, 700, 0.45, 15, false,
 'Contact only people who contacted you, opt-out honoured immediately, quiet hours respected, and every automated caller told it is automated.',
 3, 'minutes', 'in_build'),

('bundle_complete_law', 'The Whole System',
 'Every enquiry captured, followed up, and turned into an intake.',
 'Missed-call text-back, after-hours intake, five-touch nurture, reminders, the AI intake agent, instant callback, the Spanish-speaking agent, and review requests. Bought separately these are $6,150 setup and $2,800/month. Includes 700 voice minutes and 500 texts a month.',
 'bundle', array['law_firm'], 4450, 2150, 700, 0.55, 35, false,
 'No advice, no fee quotes, no case-outcome claims. Per-lead is per intake delivered, never per case signed. Solicitation rules vary by state and every sequence is reviewed against yours before it runs.',
 3, 'minutes', 'in_build'),

-- Genuinely thinner than the other two, and priced accordingly: there is no
-- voice_callback_medical in the catalog, and no per-lead component is legally
-- available. Worth knowing before quoting it next to the law tier.
('bundle_complete_medical', 'The Whole System',
 'Every call, message and no-show handled, without touching clinical detail.',
 'Missed-call text-back, after-hours intake, recall and reactivation, reminders with no-show recovery, the AI front-desk agent, and the Spanish-speaking agent. Bought separately these are $3,900 setup and $1,825/month. Includes 400 voice minutes and 500 texts a month. There is no instant-callback product for healthcare.',
 'bundle', array['medical'], 2800, 1400, 400, 0.55, null, true,
 'Requires a signed BAA covering every vendor in the path before go-live. Flat fee only - per-patient compensation can implicate anti-kickback and fee-splitting rules. Anything clinical routes to your staff; emergencies are directed to 911.',
 3, 'minutes', 'in_build')

on conflict (code) do update set
  name = excluded.name, blurb = excluded.blurb, detail = excluded.detail,
  category = excluded.category, allowed_verticals = excluded.allowed_verticals,
  setup_fee = excluded.setup_fee, monthly_fee = excluded.monthly_fee,
  included_minutes = excluded.included_minutes,
  overage_per_minute = excluded.overage_per_minute,
  per_lead_fee = excluded.per_lead_fee, requires_baa = excluded.requires_baa,
  compliance_note = excluded.compliance_note, sort = excluded.sort,
  unit_label = excluded.unit_label;

-- ----------------------------------------------------------------------------
-- What each bundle grants. sanaku_has_addon() reads this, so a client on a
-- bundle passes the gate for every part without the workflows knowing bundles
-- exist at all.
-- ----------------------------------------------------------------------------
insert into sanaku_addon_bundle_members (bundle_code, member_code) values
  ('bundle_voice_home', 'voice_reception_home'),
  ('bundle_voice_home', 'voice_callback_home'),
  ('bundle_voice_home', 'voice_spanish'),

  ('bundle_voice_law', 'voice_reception_law'),
  ('bundle_voice_law', 'voice_callback_law'),
  ('bundle_voice_law', 'voice_spanish'),

  ('bundle_complete_home', 'recover_missed_call_home'),
  ('bundle_complete_home', 'after_hours_intake_home'),
  ('bundle_complete_home', 'nurture_home'),
  ('bundle_complete_home', 'reminders_home'),
  ('bundle_complete_home', 'voice_reception_home'),
  ('bundle_complete_home', 'voice_callback_home'),
  ('bundle_complete_home', 'voice_spanish'),
  ('bundle_complete_home', 'sms_reviews'),

  ('bundle_complete_law', 'recover_missed_call_law'),
  ('bundle_complete_law', 'after_hours_intake_law'),
  ('bundle_complete_law', 'nurture_law'),
  ('bundle_complete_law', 'reminders_law'),
  ('bundle_complete_law', 'voice_reception_law'),
  ('bundle_complete_law', 'voice_callback_law'),
  ('bundle_complete_law', 'voice_spanish'),
  ('bundle_complete_law', 'sms_reviews'),

  ('bundle_complete_medical', 'recover_missed_call_medical'),
  ('bundle_complete_medical', 'after_hours_intake_medical'),
  ('bundle_complete_medical', 'nurture_medical'),
  ('bundle_complete_medical', 'reminders_medical'),
  ('bundle_complete_medical', 'voice_reception_medical'),
  ('bundle_complete_medical', 'voice_spanish')
on conflict do nothing;

-- ----------------------------------------------------------------------------
-- Enforce rule 1 rather than remembering it. A bundle that sells the phone
-- agent and the after-hours-only phone agent together charges twice for one
-- product, and it is the kind of mistake that is invisible on a price list.
-- ----------------------------------------------------------------------------
do $$
declare _bad text;
begin
  select string_agg(bundle_code, ', ') into _bad
  from (
    select bm.bundle_code
    from sanaku_addon_bundle_members bm
    group by bm.bundle_code
    having bool_or(bm.member_code = 'voice_afterhours')
       and bool_or(bm.member_code like 'voice_reception%')
  ) t;
  if _bad is not null then
    raise exception 'bundle sells after-hours answering alongside the full phone agent: %', _bad;
  end if;
end $$;

-- Bundle build_status follows its least-finished part, same rule as 011.
update sanaku_addons b set build_status = (
  select case
    when bool_and(m.build_status = 'live')     then 'live'
    when bool_or (m.build_status = 'planned')  then 'planned'
    else 'in_build'
  end
  from sanaku_addon_bundle_members bm
  join sanaku_addons m on m.code = bm.member_code
  where bm.bundle_code = b.code
)
where b.category = 'bundle'
  and exists (select 1 from sanaku_addon_bundle_members bm where bm.bundle_code = b.code);

commit;


-- ============================================================================
-- VERIFY
-- ============================================================================
select
  (select count(*) from sanaku_addon_bundle_members)                  as bundle_links,   -- expect 40
  (select count(*) from sanaku_addons where build_status = 'live')    as live_services,  -- expect 7
  (select count(*) from sanaku_addons where category = 'bundle')      as bundles,        -- expect 8
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_my_requests')                          as client_req_view;-- expect 8

-- Every bundle, what it saves, and whether it can be delivered yet.
select b.code, b.setup_fee::int as bundle_setup, b.monthly_fee::int as bundle_monthly,
       sum(m.setup_fee)::int as parts_setup, sum(m.monthly_fee)::int as parts_monthly,
       (sum(m.setup_fee) - b.setup_fee)::int as saves_setup,
       (sum(m.monthly_fee) - b.monthly_fee)::int as saves_monthly,
       b.build_status
from sanaku_addons b
join sanaku_addon_bundle_members bm on bm.bundle_code = b.code
join sanaku_addons m on m.code = bm.member_code
group by b.code, b.setup_fee, b.monthly_fee, b.build_status, b.sort
order by b.sort, b.code;
