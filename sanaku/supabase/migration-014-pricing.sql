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
-- Which clients now have a cap that binds almost immediately.
--
-- A $500 monthly cap is 33 leads at $15 and 5 leads at $100. Left alone, a
-- stale cap silently becomes the price - the client pays the cap every month
-- and the per-lead rate stops meaning anything.
-- ----------------------------------------------------------------------------
select c.company_name,
       c.per_lead_monthly_cap::int as cap,
       max(ca.per_lead_fee)::int   as rate,
       floor(c.per_lead_monthly_cap / nullif(max(ca.per_lead_fee), 0))::int as leads_until_capped
from sanaku_clients c
join sanaku_client_addons ca on ca.client_id = c.id and ca.status = 'active'
where c.per_lead_monthly_cap is not null and ca.per_lead_fee is not null
group by c.id, c.company_name, c.per_lead_monthly_cap
having floor(c.per_lead_monthly_cap / nullif(max(ca.per_lead_fee), 0)) < 10
order by 4;
