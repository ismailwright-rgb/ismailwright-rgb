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
