-- ============================================================================
-- Migration 018 - track an async phone reveal across runs
--
-- Apollo's phone reveal is NOT like the email reveal already in W1. Verified
-- live before writing this:
--
--   cost      8 credits per reveal (email is ~1) - confirmed against a real
--             call, not the docs, which quote nothing
--   shape     async. The reveal call returns a request_id immediately with NO
--             phone number; Apollo delivers the actual number some time later
--             (their own docs say "can take several minutes"), fetched by
--             polling that request_id
--   the id    up to 19 digits, SIGNED. Both real ids captured this session -
--             136173679893259947 and -9111171576208113322 - exceed
--             Number.MAX_SAFE_INTEGER. A numeric column would silently round
--             it on write, and every poll after that would ask Apollo for the
--             wrong request forever with no error pointing at why.
--
-- So the id has to survive one Supabase round trip intact, and the workflow
-- has to be able to come back on a LATER run and finish what an earlier run
-- started. Two columns, both text/timestamp - never numeric, on purpose.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects add column if not exists phone_reveal_request_id   text;
alter table sanaku_prospects add column if not exists phone_reveal_requested_at timestamptz;

comment on column sanaku_prospects.phone_reveal_request_id is
  'Apollo''s async reveal id, TEXT always - it can exceed 2^53 and a numeric column would silently round it, breaking every poll after. Cleared once resolved (found or given up).';
comment on column sanaku_prospects.phone_reveal_requested_at is
  'When the reveal was kicked off. Used to give up after ~7 days rather than polling forever.';

-- Nothing to backfill: this column has never existed before, so there is no
-- reveal in flight from before this migration ran.

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
-- What's queued for the next run to resolve, oldest first (this is exactly the
-- query W1's "Get Pending Phone Reveals" node runs):
--
--   select id, domain, phone_reveal_request_id, phone_reveal_requested_at
--     from sanaku_prospects
--    where phone_reveal_request_id is not null
--    order by phone_reveal_requested_at asc;
--
-- A row with phone_reveal_request_id set and contact_phone_source still
-- 'apollo_company' (not yet 'apollo_direct') is normal between runs - it means
-- the reveal is in flight and hasn't resolved yet, not that anything is broken.
