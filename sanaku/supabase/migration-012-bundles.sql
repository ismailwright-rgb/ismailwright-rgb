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
