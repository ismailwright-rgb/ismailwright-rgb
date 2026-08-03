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
-- What a trial now costs to enter, per service. This is just setup_fee - which
-- is the point.
-- ----------------------------------------------------------------------------
select category,
       count(*)                                  as services,
       '$' || min(setup_fee)::int || '-$' || max(setup_fee)::int as to_start,
       '$' || min(monthly_fee)::int || '-$' || max(monthly_fee)::int as then_monthly
from sanaku_addons
group by category
order by category;
