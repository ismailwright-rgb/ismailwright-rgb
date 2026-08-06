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
--   014  The pilot-billing bug, per-lead re-rated to market, per-booked-job.
--   015  The trial costs the service's own setup fee; no separate trial price.
--   016  ...capped: at most $750 due before the free month ends, balance day 31.
--   013  The 30-day trial, and the four things the invoice never billed:
--        setup fees, add-on per-lead fees, voice overage, and the free period.
--   017  Whose phone number that is. Every contact_phone in the table is the
--        switchboard; this separates the person from the business line.
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


-- ####################  migration-013-trials.sql  ####################

-- ============================================================================
-- Migration 013 - the trial offer, and the four things the invoice was missing
-- Run after migration-012-bundles.sql.
--
-- The offer: a low setup fee to start, then 30 days before any monthly charge.
--
-- Representing it turned up a bigger problem. figuresFor() in Statements.jsx is
-- the only billing calculation in the system, and it totals
-- retainer + per-lead + the sum of add-on monthly_fee. Nothing else. So:
--
--   * setup fees have never been billed - sanaku_billing had no column for one
--   * add-on per_lead_fee has never been billed - eleven catalog rows carry a
--     rate that reaches no invoice
--   * overage has never been billed
--   * starts_on was ignored, so a free period could not be expressed at all
--
-- Four of the five priced dimensions never reached a client. This migration is
-- the schema half of fixing that; Statements.jsx is the other half.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The trial price, per service.
--
--    A column rather than one promotional number, because the entry fee should
--    track what the service costs to stand up - a $250 review-request trial and
--    a $750 intake-agent trial are both "low" relative to their product.
--
--    Bundles are deliberately left null. Thirty free days of a $2,150/month
--    package is roughly six thousand dollars of contracted value per prospect,
--    and a trial is meant to be a sample. Trial a service, then buy the bundle.
-- ----------------------------------------------------------------------------
alter table sanaku_addons
  add column if not exists trial_setup_fee numeric;

alter table sanaku_addons drop constraint if exists sanaku_addons_trial_sane;
alter table sanaku_addons add constraint sanaku_addons_trial_sane
  check (trial_setup_fee is null or trial_setup_fee <= setup_fee);

comment on column sanaku_addons.trial_setup_fee is
  'Entry price for the 30-day trial. Null means this is not offered on trial - true for every bundle. Never above setup_fee.';

-- Half the normal setup, rounded to $50, floored at $250. The floor exists
-- because below it the fee stops covering the work of standing the service up.
update sanaku_addons set trial_setup_fee = greatest(250, round(setup_fee * 0.5 / 50) * 50)
where category <> 'bundle';

-- ----------------------------------------------------------------------------
-- 2. Where a client's trial actually stands.
--
--    live_on is the honest start of the clock. A client whose number is still
--    in A2P 10DLC carrier vetting is not receiving the service yet, and their
--    free month should not be burning while they wait. Voice products send no
--    SMS, need no registration, and go live the same day - which is why this is
--    a date on the row rather than a rule in code.
-- ----------------------------------------------------------------------------
alter table sanaku_client_addons
  add column if not exists live_on         date,
  add column if not exists trial_ends_on   date,
  add column if not exists setup_billed_on date;

alter table sanaku_client_addons drop constraint if exists sanaku_client_addons_trial_order;
alter table sanaku_client_addons add constraint sanaku_client_addons_trial_order
  check (trial_ends_on is null or live_on is null or trial_ends_on >= live_on);

comment on column sanaku_client_addons.live_on is
  'The day this actually started working for the client, not the day it was sold. Starts the trial clock.';
comment on column sanaku_client_addons.setup_billed_on is
  'Stamped when a statement bills the setup fee. Non-null means never charge it again.';

-- ----------------------------------------------------------------------------
-- 2b. Selling a trial must charge the trial price, without anyone remembering.
--
--     Testing this migration caught the gap: a trial row created without an
--     explicit setup_fee inherited the FULL catalog price - $750 instead of
--     $400 on the home phone agent. The offer would have been quoted at one
--     price and invoiced at another, and nothing would have flagged it.
--
--     So trial_ends_on being set is what makes it a trial, and a trial takes
--     trial_setup_fee. Staff can still override by naming a setup_fee outright.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_addon_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.sanaku_addons%rowtype;
begin
  if not public.sanaku_is_staff() then
    -- A client may express interest and nothing else. Every commercial field
    -- is overwritten, so a crafted POST cannot set its own price to zero.
    new.id            := gen_random_uuid();
    new.status        := 'requested';
    new.requested_at  := now();
    new.requested_by  := (select auth.uid());
    new.decided_at    := null;
    new.decided_by    := null;
    new.staff_note    := null;
    new.setup_fee          := null;
    new.monthly_fee        := null;
    new.included_minutes   := null;
    new.overage_per_minute := null;
    new.per_lead_fee       := null;
    new.starts_on     := null;
    new.ends_on       := null;
    new.live_on         := null;
    new.trial_ends_on   := null;
    new.setup_billed_on := null;
    return new;
  end if;

  -- Staff approving: copy the catalog terms onto the row, once. After this the
  -- subscription is independent of the catalog, so a price rise next year does
  -- not reach back and re-price this client.
  if new.status in ('approved', 'active')
     and (tg_op = 'INSERT' or old.status not in ('approved', 'active'))
     and new.monthly_fee is null then
    select * into a from public.sanaku_addons where code = new.addon_code;

    -- A trial of something not offered on trial is a mistake, not a discount.
    -- Bundles carry no trial_setup_fee on purpose - thirty free days of a
    -- $2,150/month package is thousands of dollars per prospect.
    if new.trial_ends_on is not null and a.trial_setup_fee is null then
      raise exception '% is not offered on trial (no trial_setup_fee). Sell a single service on trial, then the bundle.', new.addon_code;
    end if;

    new.setup_fee := coalesce(
      new.setup_fee,
      case when new.trial_ends_on is not null then a.trial_setup_fee else a.setup_fee end
    );
    new.monthly_fee        := coalesce(new.monthly_fee, a.monthly_fee);
    new.included_minutes   := coalesce(new.included_minutes, a.included_minutes);
    new.overage_per_minute := coalesce(new.overage_per_minute, a.overage_per_minute);
    new.per_lead_fee       := coalesce(new.per_lead_fee, a.per_lead_fee);
    new.decided_at         := coalesce(new.decided_at, now());
    new.decided_by         := coalesce(new.decided_by, (select auth.uid()));
    new.starts_on          := coalesce(new.starts_on, current_date);
    -- No default for trial_ends_on on purpose. Setting it is what declares the
    -- row a trial, so there is no state meaning "a trial whose end date I have
    -- not decided" for a default to fill in. Whoever sells it sets the date -
    -- which is right anyway, since an SMS product's clock should start after
    -- carrier vetting clears and a voice product's can start the same day.
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 3. An itemised statement.
--
--    total_due alone cannot be checked by the person paying it. These three
--    columns are what turn a number into something a client can agree with.
-- ----------------------------------------------------------------------------
alter table sanaku_billing
  add column if not exists setup_due    numeric not null default 0,
  add column if not exists addons_due   numeric not null default 0,
  add column if not exists per_lead_due numeric not null default 0,
  add column if not exists overage_due  numeric not null default 0;

comment on column sanaku_billing.overage_due is
  'Voice minutes beyond the included allowance. Texts are not metered - nothing counts messages sent - so text overage is never billed.';

-- ----------------------------------------------------------------------------
-- 4. What a client owes for a period, in one place.
--
--    Statements.jsx computes this in JS and migration-002 computed part of it
--    in SQL, which is two implementations of one commercial question. This is
--    the SQL one, and the screen is being changed to agree with it.
--
--    The per-lead rule that did not exist before: a lead is charged ONCE. At
--    the add-on's rate when its channel maps to an add-on the client holds,
--    otherwise at the client's own rate. Never both.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_addon_for_channel(_channel text)
returns text language sql immutable as $$
  select case _channel
    when 'missed_call' then 'recover_missed_call'
    when 'sms'         then 'recover_missed_call'
    when 'web_form'    then 'after_hours_intake'
    when 'chat'        then 'after_hours_intake'
    when 'voice'       then 'voice_reception'
    else null end
$$;

create or replace function public.sanaku_statement(_client_id uuid, _start date, _end date)
returns table (
  setup_due numeric, addons_due numeric, per_lead_due numeric,
  overage_due numeric, retainer_due numeric, total_due numeric,
  leads_captured int, leads_qualified int
)
language sql stable security definer set search_path = '' as $$
with c as (
  select * from public.sanaku_clients where id = _client_id
),
-- Every add-on the client is running, with its own frozen terms.
a as (
  select ca.*, ad.category
  from public.sanaku_client_addons ca
  join public.sanaku_addons ad on ad.code = ca.addon_code
  where ca.client_id = _client_id and ca.status = 'active'
),
-- In trial for this period if the trial had not ended by the period end.
trialling as (
  select *, (trial_ends_on is not null and trial_ends_on >= _end) as in_trial from a
),
l as (
  select * from public.sanaku_client_leads
  where client_id = _client_id
    and billable is not false
    and captured_at >= _start::timestamptz
    and captured_at <  (_end + 1)::timestamptz
),
-- A lead's per-lead rate: the add-on covering its channel, else the client's.
-- Leads captured while that add-on is in trial are worth nothing.
rated as (
  select l.id,
         coalesce(
           (select case when t.in_trial then 0 else t.per_lead_fee end
            from trialling t
            where t.addon_code like public.sanaku_addon_for_channel(l.channel) || '%'
            order by t.per_lead_fee desc nulls last limit 1),
           (select coalesce(per_lead_fee, 0) from c)
         ) as rate
  from l where l.qualified
),
-- Voice minutes beyond the allowance, against the voice add-on's frozen rate.
voice as (
  select greatest(0, (select coalesce(sum(duration_seconds), 0) from l where channel = 'voice') / 60.0
                     - coalesce((select max(included_minutes) from trialling
                                 where addon_code like 'voice_reception%' and not in_trial), 0)
         ) as extra_minutes,
         coalesce((select max(overage_per_minute) from trialling
                   where addon_code like 'voice_reception%' and not in_trial), 0) as rate
)
select
  (select coalesce(sum(setup_fee), 0) from trialling
    where setup_billed_on is null and live_on is not null and live_on <= _end)::numeric,
  (select coalesce(sum(monthly_fee), 0) from trialling where not in_trial)::numeric,
  least(
    (select coalesce(sum(rate), 0) from rated),
    coalesce((select per_lead_monthly_cap from c), 1e9)
  )::numeric,
  (select round((extra_minutes * rate)::numeric, 2) from voice),
  (select coalesce(monthly_retainer, 0) from c)::numeric,
  0::numeric,                                   -- filled by the wrapper below
  (select count(*) from l)::int,
  (select count(*) from l where qualified)::int
$$;

-- total_due is the sum of the parts, computed once so it cannot disagree.
create or replace function public.sanaku_statement_total(_client_id uuid, _start date, _end date)
returns numeric language sql stable as $$
  select s.setup_due + s.addons_due + s.per_lead_due + s.overage_due + s.retainer_due
  from public.sanaku_statement(_client_id, _start, _end) s
$$;

-- migration-002 shipped sanaku_period_due(), which totals retainer + per-lead
-- and knows nothing about services, setup, trials or overage. Nothing calls it
-- today, which is the only reason it has not produced a wrong invoice - but a
-- billing function that quietly under-reports is a trap sitting in the schema
-- waiting for someone to trust it. Redefined to delegate, so there is one
-- answer and the old name still works.
-- Dropped rather than replaced: the column list differs from migration-002's,
-- and Postgres refuses to change a function's return type in place.
drop function if exists public.sanaku_period_due(uuid, date, date);
create function public.sanaku_period_due(_client_id uuid, _from date, _to date)
returns table (
  leads_captured int, leads_qualified int, after_hours_leads int,
  retainer_due numeric, per_lead_due numeric, total_due numeric
)
language sql stable security definer set search_path = '' as $$
  select s.leads_captured, s.leads_qualified,
         (select count(*)::int from public.sanaku_client_leads
          where client_id = _client_id and billable is not false and after_hours
            and captured_at >= _from::timestamptz and captured_at < (_to + 1)::timestamptz),
         s.retainer_due, s.per_lead_due,
         s.setup_due + s.addons_due + s.per_lead_due + s.overage_due + s.retainer_due
  from public.sanaku_statement(_client_id, _from, _to) s
$$;

revoke execute on function public.sanaku_period_due(uuid, date, date) from public, anon;
grant   execute on function public.sanaku_period_due(uuid, date, date) to authenticated;

-- Every billable client for a period, in one round trip. The Statements screen
-- calls this instead of doing the arithmetic in JavaScript, so there is exactly
-- one answer to "what does this client owe" rather than two that can drift.
create or replace function public.sanaku_statements_for_period(_start date, _end date)
returns table (
  client_id uuid, company_name text,
  setup_due numeric, addons_due numeric, per_lead_due numeric,
  overage_due numeric, retainer_due numeric, total_due numeric,
  leads_captured int, leads_qualified int, capped boolean, in_trial boolean
)
language sql stable security definer set search_path = '' as $$
  select c.id, c.company_name,
         s.setup_due, s.addons_due, s.per_lead_due, s.overage_due, s.retainer_due,
         s.setup_due + s.addons_due + s.per_lead_due + s.overage_due + s.retainer_due,
         s.leads_captured, s.leads_qualified,
         -- Flag a capped bill so the screen can say so rather than silently
         -- showing a number smaller than the leads imply.
         (c.per_lead_monthly_cap is not null and s.per_lead_due >= c.per_lead_monthly_cap),
         exists (select 1 from public.sanaku_client_addons ca
                 where ca.client_id = c.id and ca.status = 'active'
                   and ca.trial_ends_on is not null and ca.trial_ends_on >= _end)
  from public.sanaku_clients c
  cross join lateral public.sanaku_statement(c.id, _start, _end) s
  where c.status = 'active' and c.is_demo is not true
  order by c.company_name
$$;

revoke execute on function public.sanaku_statements_for_period(date, date) from public, anon;
grant   execute on function public.sanaku_statements_for_period(date, date) to authenticated;

revoke execute on function public.sanaku_statement(uuid, date, date) from public, anon;
revoke execute on function public.sanaku_statement_total(uuid, date, date) from public, anon;
grant   execute on function public.sanaku_statement(uuid, date, date) to authenticated;
grant   execute on function public.sanaku_statement_total(uuid, date, date) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.sanaku_statement(uuid, date, date) to service_role;
    grant execute on function public.sanaku_statement_total(uuid, date, date) to service_role;
  end if;
end $$;

commit;

-- ####################  migration-014-pricing.sql  ####################

-- ============================================================================
-- Migration 014 - the pilot bug, and pricing corrected against the market
-- Run after migration-013-trials.sql.
--
-- Three things, in order of how much they matter.
--
-- 1. THE BUG. sanaku_statement() ignored sanaku_clients.billing_starts_on.
--    OnboardClient.jsx has defaulted every new client to a 30-day pilot since
--    it was written, and the site promises "before a single monthly invoice" -
--    yet the statement charged the retainer anyway. Nothing has been invoiced
--    yet so nobody was over-charged, but the first statement issued would have
--    been wrong, and wrong in the direction that loses a client.
--
-- 2. PER-LEAD WAS FAR UNDER MARKET. Angi and Thumbtack sell home-services leads
--    at $25-$120 and personal-injury leads average $284 - and those leads are
--    SHARED with three to eight competitors. Ours are exclusive inbound callers
--    who dialled that business directly. Charging $15 and $35 for the better
--    lead was leaving most of the value on the table.
--
--    The new rates are the ones site/index.html already advertises, so no
--    customer sees a rise and the public page becomes true rather than
--    aspirational.
--
-- 3. PER BOOKED JOB, for home services. Not "per retained customer" - the
--    system bills from its own meter, and outcome='booked' is the only
--    conversion event the meter actually sees (t2-voice-agent writes it from
--    appointment_booked). 'converted' is set by nobody and reported_value is
--    labelled "not a billing input" precisely because clients self-report it.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Re-rate. Existing subscriptions are untouched: sanaku_addon_guard()
--    freezes terms at approval, so this reaches new sales only.
-- ----------------------------------------------------------------------------
update sanaku_addons set per_lead_fee = 50
where per_lead_fee is not null and allowed_verticals = array['home_services'];

update sanaku_addons set per_lead_fee = 100
where per_lead_fee is not null and allowed_verticals = array['law_firm'];

-- Bundles span one vertical each, so the two statements above already cover
-- them. Medical is untouched and stays null - sanaku_addons_pricing_legal
-- refuses a per-lead fee on anything sold to healthcare.

-- ----------------------------------------------------------------------------
-- 2. Per booked job, home services only.
--
--    A booking is worth far more than a lead, so it prices higher - but the
--    client only pays when the agent actually put a job in the calendar. For a
--    contractor that is a better trade than paying per enquiry, and it is the
--    number that competes with Angi's ~$542 cost per booked HVAC job.
-- ----------------------------------------------------------------------------
alter table sanaku_addons
  add column if not exists per_lead_booked_fee numeric;

alter table sanaku_addons drop constraint if exists sanaku_addons_booked_home_only;
alter table sanaku_addons add constraint sanaku_addons_booked_home_only check (
  per_lead_booked_fee is null
  or (not ('medical' = any (allowed_verticals))
      and not ('law_firm' = any (allowed_verticals)))
);
comment on constraint sanaku_addons_booked_home_only on sanaku_addons is
  'Conversion-based pricing is home services only. A fee tied to a signed case is fee-splitting for law (ABA Model Rule 5.4) and anti-kickback exposure for healthcare.';

-- Only the products that can observe a booking: the voice agent books into the
-- calendar, so it is the one that can charge for one.
update sanaku_addons set per_lead_booked_fee = 125
where code in ('voice_reception_home', 'voice_callback_home');

comment on column sanaku_addons.per_lead_booked_fee is
  'Charged per lead with outcome=booked, INSTEAD of per_lead_fee, when the subscription is set to charge_on=booked. Never in addition.';

-- Which of the two a given client is on. Per subscription, not per catalog row,
-- because it is a commercial choice made when the deal is done.
alter table sanaku_client_addons
  add column if not exists charge_on text not null default 'qualified';
alter table sanaku_client_addons drop constraint if exists sanaku_client_addons_charge_on_check;
alter table sanaku_client_addons add constraint sanaku_client_addons_charge_on_check
  check (charge_on in ('qualified', 'booked'));

alter table sanaku_client_addons
  add column if not exists per_lead_booked_fee numeric;

-- ----------------------------------------------------------------------------
-- 3. The statement, with the pilot honoured and booked-job billing added.
--
--    During a pilot NOTHING recurring bills - not the retainer, not services,
--    not per-lead, not overage. The setup fee still does, because the offer is
--    "you pay the setup, we build it, and you watch what it catches before a
--    single monthly invoice."
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_statement(_client_id uuid, _start date, _end date)
returns table (
  setup_due numeric, addons_due numeric, per_lead_due numeric,
  overage_due numeric, retainer_due numeric, total_due numeric,
  leads_captured int, leads_qualified int
)
language sql stable security definer set search_path = '' as $$
with c as (
  select * from public.sanaku_clients where id = _client_id
),
-- The pilot window. Everything recurring is free until billing_starts_on.
pilot as (
  select (select billing_starts_on from c) is not null
     and _end < (select billing_starts_on from c) as in_pilot
),
a as (
  select ca.*, ad.category
  from public.sanaku_client_addons ca
  join public.sanaku_addons ad on ad.code = ca.addon_code
  where ca.client_id = _client_id and ca.status = 'active'
),
trialling as (
  select *, (trial_ends_on is not null and trial_ends_on >= _end) as in_trial from a
),
l as (
  select * from public.sanaku_client_leads
  where client_id = _client_id
    and billable is not false
    and captured_at >= _start::timestamptz
    and captured_at <  (_end + 1)::timestamptz
),
-- A lead is charged ONCE. At the add-on's rate when its channel maps to an
-- add-on the client holds, otherwise at the client's own rate. A subscription
-- set to charge_on='booked' charges for bookings instead of qualified leads -
-- never both.
rated as (
  select l.id,
         coalesce(
           (select case
              when t.in_trial then 0
              when t.charge_on = 'booked'
                then case when l.outcome = 'booked'
                          then coalesce(t.per_lead_booked_fee,
                                        (select per_lead_booked_fee from public.sanaku_addons
                                         where code = t.addon_code), 0)
                          else 0 end
              else case when l.qualified then coalesce(t.per_lead_fee, 0) else 0 end
            end
            from trialling t
            where t.addon_code like public.sanaku_addon_for_channel(l.channel) || '%'
            order by t.per_lead_fee desc nulls last limit 1),
           case when l.qualified then (select coalesce(per_lead_fee, 0) from c) else 0 end
         ) as rate
  from l
),
voice as (
  select greatest(0, (select coalesce(sum(duration_seconds), 0) from l where channel = 'voice') / 60.0
                     - coalesce((select max(included_minutes) from trialling
                                 where addon_code like 'voice_reception%' and not in_trial), 0)
         ) as extra_minutes,
         coalesce((select max(overage_per_minute) from trialling
                   where addon_code like 'voice_reception%' and not in_trial), 0) as rate
)
select
  -- Setup bills even in a pilot: they paid it to have the thing built.
  (select coalesce(sum(setup_fee), 0) from trialling
    where setup_billed_on is null and live_on is not null and live_on <= _end)::numeric,
  case when (select in_pilot from pilot) then 0
       else (select coalesce(sum(monthly_fee), 0) from trialling where not in_trial) end::numeric,
  case when (select in_pilot from pilot) then 0
       else least((select coalesce(sum(rate), 0) from rated),
                  coalesce((select per_lead_monthly_cap from c), 1e9)) end::numeric,
  case when (select in_pilot from pilot) then 0
       else (select round((extra_minutes * rate)::numeric, 2) from voice) end::numeric,
  case when (select in_pilot from pilot) then 0
       else (select coalesce(monthly_retainer, 0) from c) end::numeric,
  0::numeric,
  (select count(*) from l)::int,
  (select count(*) from l where qualified)::int
$$;

commit;

-- ----------------------------------------------------------------------------


-- ####################  migration-015-trial-setup.sql  ####################

-- ============================================================================
-- Migration 015 - the trial costs what the service costs to set up
-- Run after migration-014-pricing.sql.
--
-- The offer is now simply: pay the setup fee for whatever service you pick,
-- run it for 30 days, then the monthly begins. There is no separate trial
-- price and no trial discount - the free month IS the offer.
--
-- That makes trial_setup_fee (added in 013, flattened to $500 in 014) a column
-- whose only correct value is a copy of setup_fee. A column that must always
-- mirror another is a bug waiting to happen: someone eventually sets one and
-- not the other, and then two documents quote two prices. So it goes.
--
-- Consequences worth stating:
--
--   * Bundles become trialable. They were excluded when the entry fee was a
--     flat $500, because thirty free days of a $2,150/month package against
--     $500 collected is thousands of dollars of exposure per prospect. At full
--     setup - $1,200 to $4,450 - the setup covers the free month several times
--     over, so the objection is gone.
--
--   * Every service earns more up front. The cheapest trial was $250 and the
--     dearest $500; now it is whatever that service is worth to stand up.
-- ============================================================================

begin;

-- The guard no longer needs to choose between two prices, and no longer needs
-- to refuse a trial on anything: every service can be trialled at its own
-- setup fee. Rewritten rather than patched so there is no dead branch left
-- implying a trial price still exists somewhere.
create or replace function public.sanaku_addon_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a public.sanaku_addons%rowtype;
begin
  if not public.sanaku_is_staff() then
    -- A client may express interest and nothing else. Every commercial field
    -- is overwritten, so a crafted POST cannot set its own price to zero.
    new.id            := gen_random_uuid();
    new.status        := 'requested';
    new.requested_at  := now();
    new.requested_by  := (select auth.uid());
    new.decided_at    := null;
    new.decided_by    := null;
    new.staff_note    := null;
    new.setup_fee          := null;
    new.monthly_fee        := null;
    new.included_minutes   := null;
    new.overage_per_minute := null;
    new.per_lead_fee       := null;
    new.starts_on     := null;
    new.ends_on       := null;
    new.live_on         := null;
    new.trial_ends_on   := null;
    new.setup_billed_on := null;
    return new;
  end if;

  -- Staff approving: copy the catalog terms onto the row, once. After this the
  -- subscription is independent of the catalog, so a price rise next year does
  -- not reach back and re-price this client.
  if new.status in ('approved', 'active')
     and (tg_op = 'INSERT' or old.status not in ('approved', 'active'))
     and new.monthly_fee is null then
    select * into a from public.sanaku_addons where code = new.addon_code;
    new.setup_fee          := coalesce(new.setup_fee, a.setup_fee);
    new.monthly_fee        := coalesce(new.monthly_fee, a.monthly_fee);
    new.included_minutes   := coalesce(new.included_minutes, a.included_minutes);
    new.overage_per_minute := coalesce(new.overage_per_minute, a.overage_per_minute);
    new.per_lead_fee       := coalesce(new.per_lead_fee, a.per_lead_fee);
    new.per_lead_booked_fee := coalesce(new.per_lead_booked_fee, a.per_lead_booked_fee);
    new.decided_at         := coalesce(new.decided_at, now());
    new.decided_by         := coalesce(new.decided_by, (select auth.uid()));
    new.starts_on          := coalesce(new.starts_on, current_date);
    -- trial_ends_on is set by whoever sells it, and setting it is what makes
    -- the row a trial. No default: an SMS product's clock should start after
    -- carrier vetting clears, a voice product's can start the same day, and
    -- only the person doing the onboarding knows which.
  end if;
  return new;
end $$;

alter table sanaku_addons drop constraint if exists sanaku_addons_trial_sane;
alter table sanaku_addons drop column if exists trial_setup_fee;

commit;

-- ----------------------------------------------------------------------------


-- ####################  migration-016-trial-cap.sql  ####################

-- ============================================================================
-- Migration 016 - cap what a trial costs to enter
-- Run after migration-015-trial-setup.sql.
--
-- 015 made the trial entry fee the service's full setup - $250 to $4,450. That
-- is coherent, but it is not a trial. Nobody "tries" something for $4,450, and
-- asking a firm for $1,500 before a single call has been answered is the
-- opposite of a low-risk way in.
--
-- So the setup fee still scales with the service - a $1,500 build genuinely is
-- not a $250 build - but only part of it is due before the free month ends:
--
--     due to start      least(setup_fee, trial_entry_cap)
--     due at day 31     the remainder, and only if they continue
--
-- Home services is unaffected: its setups already sit at or under the cap. The
-- law and bundle products become trialable at all, which they were not.
--
-- Buying outright, with no trial, still pays the full setup up front. The cap
-- is a property of the trial, not a discount on the product.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The cap itself.
--
--    A table rather than a constant in a function, because this is a number to
--    tune against how many trials convert - and tuning it should be an UPDATE,
--    not a migration and a redeploy.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_settings (
  key        text primary key,
  value      numeric not null,
  note       text,
  updated_at timestamptz not null default now()
);

alter table sanaku_settings enable row level security;
alter table sanaku_settings force  row level security;
drop policy if exists staff_all on sanaku_settings;
create policy staff_all on sanaku_settings for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));

insert into sanaku_settings (key, value, note) values
  ('trial_entry_cap', 750,
   'Most a client pays before their free month ends. The rest of setup falls due on day 31, and only if they continue. Raise it if trials convert well; lower it if the entry fee is the objection.')
on conflict (key) do nothing;

create or replace function public.sanaku_trial_entry_cap() returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from public.sanaku_settings where key = 'trial_entry_cap'), 1e9)
$$;
revoke execute on function public.sanaku_trial_entry_cap() from public, anon;
grant   execute on function public.sanaku_trial_entry_cap() to authenticated;

-- ----------------------------------------------------------------------------
-- 2. The balance needs its own stamp, or it bills every month forever.
-- ----------------------------------------------------------------------------
alter table sanaku_client_addons
  add column if not exists setup_balance_billed_on date;

comment on column sanaku_client_addons.setup_balance_billed_on is
  'Stamped when the remainder of setup is billed at trial end. Non-null means never charge it again.';

-- ----------------------------------------------------------------------------
-- 3. The statement, splitting setup into entry and balance.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_statement(_client_id uuid, _start date, _end date)
returns table (
  setup_due numeric, addons_due numeric, per_lead_due numeric,
  overage_due numeric, retainer_due numeric, total_due numeric,
  leads_captured int, leads_qualified int
)
language sql stable security definer set search_path = '' as $$
with c as (
  select * from public.sanaku_clients where id = _client_id
),
pilot as (
  select (select billing_starts_on from c) is not null
     and _end < (select billing_starts_on from c) as in_pilot
),
a as (
  select ca.*, ad.category
  from public.sanaku_client_addons ca
  join public.sanaku_addons ad on ad.code = ca.addon_code
  where ca.client_id = _client_id and ca.status = 'active'
),
trialling as (
  select *,
         (trial_ends_on is not null and trial_ends_on >= _end) as in_trial,
         -- No trial means no cap: buying outright pays for the build up front.
         case when trial_ends_on is null then setup_fee
              else least(setup_fee, public.sanaku_trial_entry_cap()) end as entry_fee
  from a
),
l as (
  select * from public.sanaku_client_leads
  where client_id = _client_id
    and billable is not false
    and captured_at >= _start::timestamptz
    and captured_at <  (_end + 1)::timestamptz
),
rated as (
  select l.id,
         coalesce(
           (select case
              when t.in_trial then 0
              when t.charge_on = 'booked'
                then case when l.outcome = 'booked'
                          then coalesce(t.per_lead_booked_fee,
                                        (select per_lead_booked_fee from public.sanaku_addons
                                         where code = t.addon_code), 0)
                          else 0 end
              else case when l.qualified then coalesce(t.per_lead_fee, 0) else 0 end
            end
            from trialling t
            where t.addon_code like public.sanaku_addon_for_channel(l.channel) || '%'
            order by t.per_lead_fee desc nulls last limit 1),
           case when l.qualified then (select coalesce(per_lead_fee, 0) from c) else 0 end
         ) as rate
  from l
),
voice as (
  select greatest(0, (select coalesce(sum(duration_seconds), 0) from l where channel = 'voice') / 60.0
                     - coalesce((select max(included_minutes) from trialling
                                 where addon_code like 'voice_reception%' and not in_trial), 0)
         ) as extra_minutes,
         coalesce((select max(overage_per_minute) from trialling
                   where addon_code like 'voice_reception%' and not in_trial), 0) as rate
)
select
  -- Entry now; the remainder once the free month is over and they stayed.
  (
    (select coalesce(sum(entry_fee), 0) from trialling
      where setup_billed_on is null and live_on is not null and live_on <= _end)
    +
    (select coalesce(sum(setup_fee - entry_fee), 0) from trialling
      where setup_balance_billed_on is null
        and trial_ends_on is not null and trial_ends_on < _end
        and setup_fee > entry_fee)
  )::numeric,
  case when (select in_pilot from pilot) then 0
       else (select coalesce(sum(monthly_fee), 0) from trialling where not in_trial) end::numeric,
  case when (select in_pilot from pilot) then 0
       else least((select coalesce(sum(rate), 0) from rated),
                  coalesce((select per_lead_monthly_cap from c), 1e9)) end::numeric,
  case when (select in_pilot from pilot) then 0
       else (select round((extra_minutes * rate)::numeric, 2) from voice) end::numeric,
  case when (select in_pilot from pilot) then 0
       else (select coalesce(monthly_retainer, 0) from c) end::numeric,
  0::numeric,
  (select count(*) from l)::int,
  (select count(*) from l where qualified)::int
$$;

commit;

-- ----------------------------------------------------------------------------



-- ####################  migration-017-contacts.sql  ####################

-- ============================================================================
-- Migration 017 - tell the person apart from the switchboard
--
-- Every prospect in the table has a contact_phone, and every one of them is
-- the BUSINESS main line. Four places wrote it and none of them wrote a
-- person's number:
--
--   W1 Filter & Dedupe, Apollo path   org.sanitized_phone || org.phone
--   W1 Filter & Dedupe, Places path   the Google Maps listing number
--   W1 Detect & Score                 a tel: link scraped off the homepage
--   W1 Attach Contact                 company.contact_phone || person.phone
--                                     - the org number came FIRST, so even
--                                       when Apollo returned the person's own
--                                       number the front desk won
--
-- So the dashboard could show "Elaine Gorelik, Owner" and the tel: link beside
-- her name still dialled reception. Naming the decision maker is only half the
-- job; the number has to be hers, and where it is not, that has to be visible
-- rather than assumed.
--
-- Three columns, no renames. contact_phone keeps its meaning of "the best
-- number we have for this prospect" so nothing downstream breaks; what changes
-- is that we now record WHOSE number it is and keep the switchboard separately.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects add column if not exists company_phone        text;
alter table sanaku_prospects add column if not exists contact_linkedin_url text;
alter table sanaku_prospects add column if not exists contact_phone_source text;
alter table sanaku_prospects add column if not exists contact_authority     text;

comment on column sanaku_prospects.company_phone is
  'The business main line. Always the switchboard - never assume a person answers it.';
comment on column sanaku_prospects.contact_linkedin_url is
  'Apollo person profile. Open it before dialling to confirm the human is still there.';
comment on column sanaku_prospects.contact_phone_source is
  'Whose number contact_phone is. Only apollo_direct means it reaches the person.';
comment on column sanaku_prospects.contact_authority is
  'How much authority the named contact has. owner/c_suite/partner/marketing can approve; leader and staff route you; none means we have no person at all.';

-- A CHECK rather than an enum: adding a value to an enum cannot run inside a
-- transaction on older Postgres, which would make this file unsafe to re-run
-- as part of a bundle.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sanaku_prospects_phone_source_ck') then
    alter table sanaku_prospects add constraint sanaku_prospects_phone_source_ck
      check (contact_phone_source is null or contact_phone_source in
             ('apollo_direct', 'apollo_company', 'google_places', 'website', 'manual'));
  end if;
end $$;

-- The bands, in the order they matter on a call. 'marketing' is a band rather
-- than a footnote because a Director of Marketing or of Intake owns the
-- missed-call problem at a firm that has outgrown the owner answering the
-- phone - on the live LA query, one firm was reachable through no other role.
-- 'leader' (director of operations, HR, IT) is a real person but routes you
-- rather than buying, and decision_maker stays false for them.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sanaku_prospects_authority_ck') then
    alter table sanaku_prospects add constraint sanaku_prospects_authority_ck
      check (contact_authority is null or contact_authority in
             ('owner', 'c_suite', 'partner', 'marketing', 'leader', 'staff', 'none'));
  end if;
end $$;

-- Backfill. Every existing contact_phone is a main line - no direct dial has
-- ever been revealed, so there is nothing to guess at and nothing is lost.
update sanaku_prospects
   set company_phone = contact_phone
 where company_phone is null
   and contact_phone is not null;

-- Old rows: W1 set decision_maker true for anything Apollo returned, which was
-- as fine-grained as the data then allowed. Nothing recorded WHICH kind, and
-- re-deriving it from a title string here would be guessing at the one thing
-- this column exists to stop guessing at. 'none' where there is no name;
-- everything else waits for the next scrape to say so properly.
update sanaku_prospects
   set contact_authority = 'none'
 where contact_authority is null
   and contact_name is null;

update sanaku_prospects
   set contact_phone_source = case source
         when 'apollo'        then 'apollo_company'
         when 'google_places' then 'google_places'
         else 'manual'
       end
 where contact_phone_source is null
   and contact_phone is not null;

-- The follow-up queue lists its columns explicitly, so new ones are invisible
-- to it until named here. Calling from this view without knowing whether the
-- number reaches the person is the exact problem this migration exists for.
--
-- DROP, not CREATE OR REPLACE: replace can only append columns, never insert
-- one, and contact_title belongs beside contact_name rather than tacked on the
-- end. Caught by re-running the chain - "cannot change name of view column
-- contact_phone to contact_title" aborts the whole paste at this line.
drop view if exists v_followups_due;
create view v_followups_due as
select
  id, company_name, vertical, tier, intent_score, status,
  contact_name, contact_title, contact_authority, contact_phone, contact_email,
  company_phone, contact_phone_source, contact_linkedin_url, decision_maker,
  next_action, next_action_at, last_activity_at
from sanaku_prospects
where next_action_at is not null
  and next_action_at <= now()
  and do_not_contact = false
  and status not in ('won', 'lost', 'dnc')
order by next_action_at asc;

-- Dropping the view threw away its security_invoker setting, and a view without
-- it runs with OWNER rights - which is an RLS bypass, the exact hole
-- migration-004 was written to close. RUN-THIS-NOW.sql sets this in a loop that
-- has already run by the time this file executes, so it does not come back on
-- its own. Re-apply it here, next to the drop that lost it.
alter view v_followups_due set (security_invoker = on);

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
-- Who we would actually reach, by source of the number:
--
--   select coalesce(contact_phone_source, 'none') as number_reaches,
--          count(*),
--          count(*) filter (where contact_name is not null) as named_contact
--     from sanaku_prospects group by 1 order by 2 desc;
--
-- Anything other than apollo_direct means: dial the main line and ask for them.

-- ============================================================================
-- VERIFY
-- ============================================================================
select
  (select count(*) from sanaku_addon_bundle_members)                  as bundle_links,   -- expect 40
  (select count(*) from sanaku_addons where build_status = 'live')    as live_services,  -- expect 7
  (select count(*) from sanaku_addons where category = 'bundle')      as bundles,        -- expect 8
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_my_requests')                          as client_req_view,-- expect 8
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_prospects'
      and column_name in ('company_phone', 'contact_linkedin_url',
                          'contact_phone_source', 'contact_authority'))as contact_cols;   -- expect 4

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

-- What a trial costs to walk in the door, and what falls due on day 31.
select category,
       '$'||min(least(setup_fee, sanaku_trial_entry_cap()))::int||'-$'
          ||max(least(setup_fee, sanaku_trial_entry_cap()))::int as to_start,
       '$'||min(setup_fee - least(setup_fee, sanaku_trial_entry_cap()))::int||'-$'
          ||max(setup_fee - least(setup_fee, sanaku_trial_entry_cap()))::int as balance_day_31,
       '$'||min(monthly_fee)::int||'-$'||max(monthly_fee)::int as then_monthly
from sanaku_addons group by category order by category;
