-- ============================================================================
-- Migration 027 - make the send counter mean what the dashboard says it means
--
-- WHAT WENT WRONG (2026-08-11). W2s attempted 12 sends. Every one failed with
-- a TCP connection timeout to smtppro.zoho.com:587 - the droplet cannot reach
-- outbound SMTP at all. Zero emails were delivered.
--
-- The dashboard reported "11 of 15 sends used today".
--
-- Three separate defects turned one network problem into a false report:
--
--   1. sanaku_claim_send_slot() increments BEFORE the send and nothing ever
--      gives the slot back. The counter therefore measures attempts, while
--      the dashboard labels it sends. 12 failures rendered as 12 sends.
--
--   2. Every attempt targeted the SAME prospect. A failed send left the row
--      at 'approved' with nothing recording that it had just failed, so the
--      next run selected it again. One unreachable address would have consumed
--      the entire daily cap, every day, while 14 reachable ones waited.
--
--   3. n8n reported all 15 executions as "success", because the SMTP failure
--      routes to a handled error branch. The failures WERE written to
--      sanaku_errors - they were simply not surfaced anywhere a human looks.
--
-- This migration fixes 1 and 2. The sender rewrite (SMTP -> Zoho Mail REST
-- API over 443, which the droplet can actually reach) fixes the root cause,
-- and the dashboard change fixes 3.
--
-- Safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Give the slot back when the send fails
-- ----------------------------------------------------------------------------
-- The claim stays where it is. Claiming BEFORE the send is what makes the cap
-- safe under concurrency: two runs cannot both take the last slot, because the
-- increment and the test happen in one statement. Releasing on failure keeps
-- that guarantee while making the number honest - the counter now measures
-- sends that actually left, which is what the cap is meant to limit and what
-- the dashboard claims to show.
--
-- greatest(sent - 1, 0) because a counter that can go negative would hide a
-- double-release behind a plausible-looking number.
create or replace function public.sanaku_release_send_slot()
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare ok boolean;
begin
  update public.sanaku_send_budget
     set sent = greatest(sent - 1, 0), updated_at = now()
   where day = current_date
  returning true into ok;

  return coalesce(ok, false);
end $$;

comment on function public.sanaku_release_send_slot() is
  'Returns a slot claimed by sanaku_claim_send_slot() when the send failed. Call it ONLY on failure - calling it after a successful send would let the ramp be exceeded.';

revoke execute on function public.sanaku_release_send_slot() from public, anon;
grant execute on function public.sanaku_release_send_slot() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. Remember that a send failed, so the next run picks somebody else
-- ----------------------------------------------------------------------------
alter table public.sanaku_prospects
  add column if not exists send_failed_at    timestamptz,
  add column if not exists send_failures     integer not null default 0,
  add column if not exists send_last_error   text;

comment on column public.sanaku_prospects.send_failed_at is
  'When the most recent send attempt failed. W2s orders by this ascending-nulls-first, so a prospect that has never failed is always tried before one that has.';
comment on column public.sanaku_prospects.send_failures is
  'Consecutive failed attempts. At 3 the prospect is parked at send_blocked rather than retried - three failures is an address or a route problem, not bad luck.';

-- A prospect that has failed three times in a row is not a transient problem.
-- Parking it keeps the queue moving and leaves a status a human can search for.
alter table public.sanaku_prospects drop constraint if exists sanaku_prospects_status_check;
alter table public.sanaku_prospects add constraint sanaku_prospects_status_check
  check (status = any (array[
    'new', 'queued', 'draft_review', 'approved', 'skipped',
    'contacted', 'replied', 'demo_booked', 'won', 'lost', 'dnc',
    'send_blocked'   -- 3 consecutive send failures; needs a human
  ]));

-- ----------------------------------------------------------------------------
-- 3. Record the failure and free the slot in one call
-- ----------------------------------------------------------------------------
-- One function rather than three writes from the workflow, so a failure can
-- never half-record: releasing the slot but not marking the prospect is what
-- produced the retry loop in the first place.
create or replace function public.sanaku_record_send_failure(
  p_prospect uuid,
  p_error    text
)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare n integer;
begin
  perform public.sanaku_release_send_slot();

  update public.sanaku_prospects
     set send_failures   = send_failures + 1,
         send_failed_at  = now(),
         send_last_error = left(coalesce(p_error, 'unknown'), 500)
   where id = p_prospect
  returning send_failures into n;

  if n is null then
    return 'no_such_prospect';
  end if;

  if n >= 3 then
    update public.sanaku_prospects
       set status = 'send_blocked'
     where id = p_prospect and status = 'approved';
    return 'blocked';
  end if;

  return 'will_retry';
end $$;

revoke execute on function public.sanaku_record_send_failure(uuid, text) from public, anon;
grant execute on function public.sanaku_record_send_failure(uuid, text) to authenticated, service_role;

-- A successful send clears the counter, so three failures spread across three
-- weeks never add up to a block.
create or replace function public.sanaku_clear_send_failures(p_prospect uuid)
returns void
language sql
security definer
set search_path to ''
as $$
  update public.sanaku_prospects
     set send_failures = 0, send_failed_at = null, send_last_error = null
   where id = p_prospect;
$$;

revoke execute on function public.sanaku_clear_send_failures(uuid) from public, anon;
grant execute on function public.sanaku_clear_send_failures(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Undo the phantom count
-- ----------------------------------------------------------------------------
-- Today's 12 claims correspond to 12 timeouts and zero delivered emails. The
-- honest value is the number of sends actually logged for today, which is 0.
--
-- Scoped to current_date and to the specific condition (no outbound email
-- conversation rows exist at all), so re-running this later cannot wipe a real
-- day's count.
update public.sanaku_send_budget
   set sent = 0, updated_at = now()
 where day = current_date
   and not exists (
     select 1 from public.sanaku_conversations
      where channel = 'email' and direction = 'outbound'
        and sent_at::date = current_date
   );

-- The 12 attempts all hit one prospect. Clear its failure count so it starts
-- clean under the new sender rather than arriving pre-blocked for a fault that
-- was never its own.
update public.sanaku_prospects
   set send_failures = 0, send_failed_at = null, send_last_error = null
 where send_failures > 0;

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select day, cap, sent from sanaku_send_budget where day = current_date;
--   -- expect sent = 0
--
--   -- claim, then release; sent must return to where it started
--   select public.sanaku_claim_send_slot();
--   select public.sanaku_release_send_slot();
--
--   select status, count(*) from sanaku_prospects group by 1 order by 2 desc;
--
--   -- what actually left the building, ever:
--   select count(*) from sanaku_conversations
--    where channel = 'email' and direction = 'outbound';
