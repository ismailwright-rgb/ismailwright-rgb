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
-- VERIFY - what each vertical is offered, in the order they will see it:
--   select v as vertical, sort, name, setup_fee, monthly_fee
--   from sanaku_addons, unnest(allowed_verticals) as v
--   where active order by v, sort, name;
-- ============================================================================
