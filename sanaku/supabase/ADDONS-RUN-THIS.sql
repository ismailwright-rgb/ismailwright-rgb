-- ============================================================================
-- SANAKU - ADD-ONS. RUN THIS ONE FILE.
--
-- Supabase -> SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run more than once. Takes a couple of seconds.
--
-- Requires RUN-THIS-NOW.sql (the security fix) to have been run already.
--
-- Installs:
--   1. The add-on catalog + the request/approve flow, with the rules that stop
--      a client pricing their own subscription
--   2. Voice agents (phone agent, instant callback, after-hours, Spanish)
--   3. The four lead-recovery workflows from the one-pager, plus a bundle
--
-- After running, scroll to the bottom for the verification query.
-- ============================================================================


-- ==========================================================================
-- PART 1 + 2 - catalog, request flow, voice agents
-- ==========================================================================
-- ============================================================================
-- Migration 007 - add-on catalog and self-serve requests
-- Run after migration-004-security.sql.
--
-- A client opens their portal, sees what else you offer, sees exactly what it
-- costs, and asks for it. You approve. Nothing bills until you do.
--
-- Two rules are enforced here rather than remembered:
--
--   1. A client can never activate their own billing. They INSERT a row with
--      status 'requested'; only staff may move it forward. A voice agent needs
--      a number provisioned, a script written and an agreement amended - it is
--      not a checkbox.
--
--   2. Terms are FROZEN onto the subscription at approval. Raising a catalog
--      price must never silently re-price a client who signed up last quarter.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. The catalog.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_addons (
  code               text primary key,
  name               text not null,
  blurb              text not null,
  detail             text,
  category           text not null default 'voice',
  -- Which verticals may buy this. A client only ever sees their own.
  allowed_verticals  text[] not null,
  setup_fee          numeric not null default 0,
  monthly_fee        numeric not null default 0,
  included_minutes   integer,
  overage_per_minute numeric,
  per_lead_fee       numeric,
  requires_baa       boolean not null default false,
  compliance_note    text,
  sort               integer not null default 100,
  active             boolean not null default true,

  -- Same rule as migration-002, applied to add-ons: healthcare pays flat.
  -- Per-patient compensation can implicate anti-kickback and fee-splitting
  -- rules, so an illegal structure is not representable, not merely
  -- discouraged.
  constraint sanaku_addons_pricing_legal check (
    per_lead_fee is null or not ('medical' = any (allowed_verticals))
  )
);

-- ----------------------------------------------------------------------------
-- 2. What a given client has asked for / is running.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_client_addons (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references sanaku_clients (id) on delete cascade,
  addon_code    text not null references sanaku_addons (code),
  status        text not null default 'requested'
                check (status in ('requested', 'approved', 'active', 'declined', 'cancelled')),
  requested_at  timestamptz not null default now(),
  requested_by  uuid references auth.users on delete set null,
  client_note   text,
  decided_at    timestamptz,
  decided_by    uuid references auth.users on delete set null,
  staff_note    text,
  -- Frozen at approval. Null while merely requested.
  setup_fee          numeric,
  monthly_fee        numeric,
  included_minutes   integer,
  overage_per_minute numeric,
  per_lead_fee       numeric,
  starts_on     date,
  ends_on       date
);

create index if not exists sanaku_client_addons_client_idx
  on sanaku_client_addons (client_id, status);

-- One live subscription per add-on per client. Partial, because a declined or
-- cancelled request must not block asking again later.
create unique index if not exists sanaku_client_addons_live_uniq
  on sanaku_client_addons (client_id, addon_code)
  where status in ('requested', 'approved', 'active');

-- ----------------------------------------------------------------------------
-- 3. Which vertical the caller belongs to.
--    security definer: sanaku_clients is staff-only, so a client's own policy
--    cannot read it directly. Zero-argument by design - taking a client_id
--    would make it an oracle any authenticated user could walk.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_my_vertical() returns text
language sql stable security definer set search_path = '' as $$
  select c.vertical
  from public.sanaku_clients c
  where c.id in (select public.sanaku_my_clients())
  limit 1
$$;
revoke execute on function public.sanaku_my_vertical() from public, anon;
grant   execute on function public.sanaku_my_vertical() to authenticated;

-- ----------------------------------------------------------------------------
-- 4. Freeze terms at approval, and stop a client writing their own price.
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
    new.decided_at         := coalesce(new.decided_at, now());
    new.decided_by         := coalesce(new.decided_by, (select auth.uid()));
    new.starts_on          := coalesce(new.starts_on, current_date);
  end if;
  return new;
end $$;

drop trigger if exists sanaku_addon_guard_bi on sanaku_client_addons;
create trigger sanaku_addon_guard_bi before insert or update on sanaku_client_addons
  for each row execute function public.sanaku_addon_guard();

-- ----------------------------------------------------------------------------
-- 5. Row level security.
-- ----------------------------------------------------------------------------
alter table sanaku_addons        enable row level security;
alter table sanaku_addons        force  row level security;
alter table sanaku_client_addons enable row level security;
alter table sanaku_client_addons force  row level security;

drop policy if exists staff_all    on sanaku_addons;
drop policy if exists client_read  on sanaku_addons;
create policy staff_all on sanaku_addons for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
-- A client sees the live catalog for their own vertical only. Not because
-- prices are secret, but because showing a plumber the law-firm rate for the
-- same product is a conversation you do not want to have.
create policy client_read on sanaku_addons for select to authenticated
  using (active and (select public.sanaku_my_vertical()) = any (allowed_verticals));

drop policy if exists staff_all      on sanaku_client_addons;
drop policy if exists client_read    on sanaku_client_addons;
drop policy if exists client_request on sanaku_client_addons;
create policy staff_all on sanaku_client_addons for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));
create policy client_read on sanaku_client_addons for select to authenticated
  using (client_id in (select public.sanaku_my_clients()));
create policy client_request on sanaku_client_addons for insert to authenticated
  with check (client_id in (select public.sanaku_my_clients()) and status = 'requested');
-- Deliberately no client UPDATE policy. With one, PostgREST's on_conflict
-- upsert would let a client flip their own request to 'active'.

-- ----------------------------------------------------------------------------
-- 6. The catalog itself.
--
--    Priced off real unit cost. An all-in voice minute runs roughly $0.13-0.18
--    (Vapi platform + speech-to-text + model + voice + Twilio), so 400 included
--    minutes costs about $60-70 to serve. The rest is provisioning, the script,
--    the calendar wiring and carrying the support.
--
--    Law and medical price higher than home services because intake is longer,
--    the script needs more care, and one captured matter is worth far more.
-- ----------------------------------------------------------------------------
insert into sanaku_addons
  (code, name, blurb, detail, category, allowed_verticals, setup_fee, monthly_fee,
   included_minutes, overage_per_minute, per_lead_fee, requires_baa, compliance_note, sort)
values

('voice_reception_home', 'AI Phone Agent',
 'Answers every call you miss, qualifies the caller, and books the job.',
 'Picks up on the second ring, 24/7. Asks what the job is, where they are, and when they need someone. Books straight into your calendar and texts you a summary. Callers who are not a fit get handled politely instead of clogging your voicemail.',
 'voice', array['home_services'], 750, 350, 400, 0.45, null, false,
 'Callers are told they are speaking with an automated assistant, and that the call is recorded, before anything else is asked.', 10),

('voice_reception_law', 'AI Intake Agent',
 'Answers every call you miss and runs a first-pass intake.',
 'Collects name, contact, incident date, and a short description, then flags conflicts-of-interest keywords for your review. Never gives legal advice, never quotes fees, never forms a relationship - it takes the intake and hands it to you.',
 'voice', array['law_firm'], 1500, 650, 400, 0.55, 35, false,
 'The agent states it is not a lawyer and cannot give legal advice. Per-lead pricing is per intake DELIVERED, never per case signed - a share of fees or recoveries would be fee-splitting with a non-lawyer.', 10),

('voice_reception_medical', 'AI Front-Desk Agent',
 'Answers overflow and after-hours calls, and takes appointment requests.',
 'Handles scheduling requests, directions, and hours. Anything clinical is routed to your staff, not answered. Emergencies are directed to call 911.',
 'voice', array['medical'], 1500, 650, 400, 0.55, null, true,
 'Requires a signed BAA with every vendor in the call path before go-live. Flat fee only - per-patient compensation can implicate anti-kickback and fee-splitting rules.', 10),

('voice_callback_home', 'Instant Lead Callback',
 'Calls a web enquiry back within 60 seconds, while they are still on your site.',
 'The first business to call back usually wins the job. When a form is submitted the agent rings them straight away, confirms the work, and books it.',
 'voice', array['home_services'], 500, 250, 300, 0.45, 20, false,
 'Only calls people who just contacted YOU, about the thing they contacted you about. No cold outbound - an AI voice is an artificial voice under the TCPA, and calling a mobile without prior express written consent carries $500-$1,500 per call.', 20),

('voice_callback_law', 'Instant Lead Callback',
 'Calls a web enquiry back within 60 seconds and runs intake.',
 'Rings a form submitter immediately, takes the intake, and books a consultation. The difference between a signed matter and a voicemail is usually minutes.',
 'voice', array['law_firm'], 1000, 450, 300, 0.55, 35, false,
 'Only calls people who just contacted you. Per-lead pricing is per intake delivered, never per case signed.', 20),

('voice_afterhours', 'After-Hours Answering',
 'The phone agent, but only outside your opening hours.',
 'The cheapest way in. Same agent, running only when you are closed - which is when most of the calls you lose actually arrive.',
 'voice', array['home_services', 'law_firm', 'medical'], 350, 175, 150, 0.45, null, false,
 'Callers are told they are speaking with an automated assistant and that the call is recorded.', 30),

('voice_spanish', 'Spanish-Speaking Agent',
 'Your agent handles Spanish callers in Spanish.',
 'Detects the caller''s language and switches. Added to any voice add-on above.',
 'voice', array['home_services', 'law_firm', 'medical'], 250, 100, null, null, null, false,
 null, 40),

('sms_reviews', 'Review Requests',
 'Texts a review link after every completed job.',
 'Sends once, a day after the work is marked done, and never chases. Replies come to you, not to a robot.',
 'messaging', array['home_services', 'law_firm'], 250, 100, null, null, null, false,
 'Texts go only to customers you have served, and every message carries opt-out instructions that are honoured immediately. Reviews are never incentivised or filtered by rating.', 50)

on conflict (code) do update set
  name = excluded.name, blurb = excluded.blurb, detail = excluded.detail,
  category = excluded.category, allowed_verticals = excluded.allowed_verticals,
  setup_fee = excluded.setup_fee, monthly_fee = excluded.monthly_fee,
  included_minutes = excluded.included_minutes,
  overage_per_minute = excluded.overage_per_minute,
  per_lead_fee = excluded.per_lead_fee, requires_baa = excluded.requires_baa,
  compliance_note = excluded.compliance_note, sort = excluded.sort;

commit;


-- ==========================================================================
-- PART 3 - the four lead-recovery workflows
-- ==========================================================================
-- ============================================================================
-- Migration 008 - the four lead-recovery workflows as add-ons
-- Run after migration-007-addons.sql.
--
-- These are the workflows on the leak one-pager: missed-call text-back,
-- after-hours intake, nurture sequences, and reminders / no-show recovery.
-- They are messaging products, so they cost a fraction of a voice minute to
-- run - a text is about $0.011 all-in against $0.13-0.18 for a voice minute.
-- Priced on what a recovered job is worth, not on what a text costs.
--
-- Rows are per vertical because law and medical carry different obligations,
-- not because the software differs. A client only ever sees their own.
-- ============================================================================

begin;

-- included_minutes / overage_per_minute are reused for message counts on these
-- products. Without a unit the portal would tell a client their texting plan
-- includes "500 min", so the label travels with the row.
alter table sanaku_addons
  add column if not exists unit_label text not null default 'min';

insert into sanaku_addons
  (code, name, blurb, detail, category, allowed_verticals, setup_fee, monthly_fee,
   included_minutes, overage_per_minute, per_lead_fee, requires_baa, compliance_note,
   sort, unit_label)
values

-- 01 -- Missed-Call Text-Back --------------------------------------------------
('recover_missed_call_home', 'Missed-Call Text-Back',
 'A call goes unanswered and the caller gets a text from your number within seconds.',
 '"Sorry we missed you - what do you need help with?" The reply is captured, qualified, and you are alerted. A plumber missing 6 calls a week who recovers just 2 jobs has already paid for the service.',
 'messaging', array['home_services'], 500, 250, 500, 0.05, 15, false,
 'Texts reply only to people who just called you, carry your business name, and honour STOP immediately. Requires A2P 10DLC registration of your number, which we handle.', 60, 'texts'),

('recover_missed_call_law', 'Missed-Call Text-Back',
 'A missed call gets an immediate text from your number, and the reply becomes an intake.',
 'The caller is asked what happened and when. Nothing is advised, nothing is promised - the reply is captured and flagged for you.',
 'messaging', array['law_firm'], 900, 450, 500, 0.07, 35, false,
 'No legal advice and no fee quotes are ever sent. Per-lead is per intake delivered, never per case signed. Honours STOP immediately.', 60, 'texts'),

('recover_missed_call_medical', 'Missed-Call Text-Back',
 'A missed call gets an immediate text offering to book or route the caller.',
 'Handles scheduling and general enquiries. Anything clinical routes to your staff rather than being answered, and urgent callers are directed to call 911.',
 'messaging', array['medical'], 650, 325, 500, 0.07, null, true,
 'Requires a signed BAA before go-live. Messages carry no clinical detail. Flat fee only - per-patient compensation can implicate anti-kickback rules.', 60, 'texts'),

-- 02 -- After-Hours Intake -----------------------------------------------------
('after_hours_intake_home', 'After-Hours Intake',
 'When you are closed, the three questions that qualify a lead get asked anyway.',
 'A smart form or chat qualifies the enquiry, books the appointment, or escalates genuinely urgent work to your on-call phone. Typically 30-45% of captured leads arrive when the office is closed.',
 'messaging', array['home_services'], 400, 200, null, null, 15, false,
 'Escalation rules and quiet hours are yours to set. No message goes out between 9pm and 8am local time unless you have marked it urgent.', 61, 'texts'),

('after_hours_intake_law', 'After-Hours Intake',
 'Out-of-hours enquiries get a real intake instead of a voicemail box.',
 'Collects name, contact, incident date and a short description, flags conflict keywords, and books a consultation slot. Urgent matters escalate to your phone.',
 'messaging', array['law_firm'], 750, 350, null, null, 35, false,
 'No legal advice, no fee quotes, no relationship formed. Per-lead is per intake delivered.', 61, 'texts'),

('after_hours_intake_medical', 'After-Hours Intake',
 'Out-of-hours patients can request an appointment instead of waiting for morning.',
 'Takes appointment requests and general enquiries, routes anything clinical to your staff, and directs emergencies to call 911.',
 'messaging', array['medical'], 550, 275, null, null, null, true,
 'Requires a signed BAA. Collects the minimum necessary and never asks for clinical detail.', 61, 'texts'),

-- 03 -- Lead Nurture -----------------------------------------------------------
('nurture_home', 'Lead Nurture Sequences',
 'Five-touch follow-up for everyone who enquired and went quiet.',
 'Most businesses follow up once and stop. The sale usually happens on touch three or four. This re-engages the 60%+ of enquiries that never got a second touch.',
 'messaging', array['home_services'], 500, 225, null, null, 15, false,
 'Only contacts people who enquired with you. Every email carries your postal address and a working unsubscribe; every text honours STOP. Anyone who replies is taken out of the sequence immediately.', 62, 'texts'),

('nurture_law', 'Lead Nurture Sequences',
 'Five-touch follow-up for enquiries that went quiet before signing.',
 'Written to stay useful rather than pushy - what to expect, what to gather, how long things take. Anyone who replies drops out of the sequence and comes to you.',
 'messaging', array['law_firm'], 900, 400, null, null, 35, false,
 'No advice, no case-outcome claims, no urgency pressure. Solicitation rules vary by state and the sequence is reviewed against yours before it runs.', 62, 'texts'),

('nurture_medical', 'Recall & Reactivation',
 'Brings back patients who have not been seen in a while.',
 'A short, plain reminder that they are due - no diagnosis, no treatment detail, no history.',
 'messaging', array['medical'], 500, 250, null, null, null, true,
 'Requires a signed BAA. Content is limited to the fact that an appointment is due. Flat fee only.', 62, 'texts'),

-- 04 -- Reminders & No-Show Recovery -------------------------------------------
('reminders_home', 'Reminders & No-Show Recovery',
 'Confirmations at booking, reminders at 24h and 1h, and a rebook offer after a no-show.',
 'Plus an automatic "life happens - want to rebook?" the morning after. Cutting no-shows from 20% to 10% recovers thousands a month.',
 'messaging', array['home_services'], 350, 175, null, null, null, false,
 'Reminders are transactional and go only to booked customers. Opt-out is honoured immediately.', 63, 'texts'),

('reminders_law', 'Reminders & No-Show Recovery',
 'Consultation confirmations, reminders, and an automatic rebook offer.',
 'A missed consultation is usually a missed matter. Confirm at booking, remind at 24h and 1h, and offer a new slot the next morning.',
 'messaging', array['law_firm'], 600, 300, null, null, null, false,
 'Reminders go only to people with a booked appointment, and carry no matter detail.', 63, 'texts'),

('reminders_medical', 'Reminders & No-Show Recovery',
 'Appointment confirmations, reminders, and same-week rebooking after a no-show.',
 'Cutting no-shows from 20% to 10% at a practice recovers thousands per month, and the chair does not sit empty.',
 'messaging', array['medical'], 450, 225, null, null, null, true,
 'Requires a signed BAA. Appointment reminders are permitted patient communication, and these carry date, time and location only - no clinical detail.', 63, 'texts'),

-- Bundle -----------------------------------------------------------------------
-- Priced below the sum of its parts on purpose: the four overlap heavily in
-- setup, and one client running all four costs barely more to serve than one
-- running two.
('bundle_recovery_home', 'Complete Lead Recovery',
 'All four recovery workflows, set up together.',
 'Missed-call text-back, after-hours intake, five-touch nurture, and reminders with no-show recovery. Bought separately these are $1,750 setup and $850/month.',
 'bundle', array['home_services'], 1200, 650, 500, 0.05, 15, false,
 'Same rules as each part: contact only people who contacted you, opt-out honoured immediately, quiet hours respected.', 5, 'texts'),

('bundle_recovery_law', 'Complete Lead Recovery',
 'All four recovery workflows, set up together.',
 'Missed-call text-back, after-hours intake, five-touch nurture, and reminders with no-show recovery. Bought separately these are $3,150 setup and $1,500/month.',
 'bundle', array['law_firm'], 2200, 1100, 500, 0.07, 35, false,
 'No advice, no fee quotes, no case-outcome claims. Per-lead is per intake delivered, never per case signed.', 5, 'texts'),

('bundle_recovery_medical', 'Complete Lead Recovery',
 'All four recovery workflows, set up together.',
 'Missed-call text-back, after-hours intake, recall and reactivation, and reminders with no-show recovery. Bought separately these are $2,150 setup and $1,075/month.',
 'bundle', array['medical'], 1600, 850, 500, 0.07, null, true,
 'Requires a signed BAA covering every vendor in the path. Flat fee only.', 5, 'texts')

on conflict (code) do update set
  name = excluded.name, blurb = excluded.blurb, detail = excluded.detail,
  category = excluded.category, allowed_verticals = excluded.allowed_verticals,
  setup_fee = excluded.setup_fee, monthly_fee = excluded.monthly_fee,
  included_minutes = excluded.included_minutes,
  overage_per_minute = excluded.overage_per_minute,
  per_lead_fee = excluded.per_lead_fee, requires_baa = excluded.requires_baa,
  compliance_note = excluded.compliance_note, sort = excluded.sort,
  unit_label = excluded.unit_label;

commit;


-- ============================================================================
-- VERIFY - every service each vertical will be offered, in menu order.
-- Expect 23 rows.
-- ============================================================================
select v as vertical, sort, name,
       setup_fee   as start_up,
       monthly_fee as per_month,
       per_lead_fee as per_lead,
       included_minutes || ' ' || unit_label as included
from sanaku_addons, unnest(allowed_verticals) as v
where active
order by v, sort, name;
