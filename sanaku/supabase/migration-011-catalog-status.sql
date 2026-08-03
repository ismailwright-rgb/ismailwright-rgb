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
