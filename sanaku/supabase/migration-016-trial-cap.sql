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
-- What a trial now costs to walk in the door, per service.
-- ----------------------------------------------------------------------------
select category,
       '$' || min(least(setup_fee, sanaku_trial_entry_cap()))::int || '-$'
           || max(least(setup_fee, sanaku_trial_entry_cap()))::int as to_start,
       '$' || min(setup_fee - least(setup_fee, sanaku_trial_entry_cap()))::int || '-$'
           || max(setup_fee - least(setup_fee, sanaku_trial_entry_cap()))::int as balance_day_31,
       '$' || min(monthly_fee)::int || '-$' || max(monthly_fee)::int as then_monthly
from sanaku_addons group by category order by category;
