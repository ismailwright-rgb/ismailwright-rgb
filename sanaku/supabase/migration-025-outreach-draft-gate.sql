-- ============================================================================
-- Migration 025 - the second approval gate, and the fields it needs
--
-- Today there is ONE gate: approving a prospect in the dashboard sets
-- status='queued', and W2 then drafts AND sends unattended. Nobody sees the
-- email that goes out under Ismail's name until after it has gone out.
--
-- This adds the second gate. W2 splits: the draft half writes the subject and
-- body onto the prospect and stops at 'draft_review'; the send half only ever
-- reads 'approved'. Nothing reaches a stranger's inbox unread.
--
-- ---------------------------------------------------------------------------
-- Why the status values are ADDED and nothing is renamed
-- ---------------------------------------------------------------------------
-- Three other workflows write status by id: W2b sets 'replied' and 'dnc', W3
-- sets 'demo_booked'. None of them check the current value first, so adding
-- values cannot break them - but renaming one would, silently, at the moment a
-- prospect replies. 'contacted' therefore keeps its meaning of "the opener has
-- gone out" even though 'sent' would read better; the dashboard, W2's own
-- Get In Sequence query and 45-day lockout all depend on it.
--
-- The full machine after this migration:
--
--   new ──W1──▶ queued ──dashboard──▶ draft_review ──W2 draft──▶ approved
--                                            │  (Ismail reads it)      │
--                                            ▼                         ▼
--                                         skipped              contacted ──W2 send
--                                                                     │
--                          replied / demo_booked / dnc / lost / won ◀──┘
--
-- 'won' was already in the CHECK and is still set by nobody - left alone
-- rather than removed, because removing it is a schema change with no benefit.
--
-- Safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The drafted email, held on the prospect
-- ----------------------------------------------------------------------------
-- On the prospect rather than in a side table because the sequence is serial:
-- a prospect has at most one email awaiting review at any moment. A side table
-- would buy history at the cost of a join on every dashboard read, and history
-- already exists in sanaku_conversations once the thing actually sends.
alter table public.sanaku_prospects
  add column if not exists draft_subject      text,
  add column if not exists draft_body         text,
  add column if not exists draft_step         integer,
  add column if not exists draft_angle        text,
  add column if not exists draft_generated_at timestamptz,
  add column if not exists draft_model        text,
  add column if not exists draft_edited       boolean not null default false,
  add column if not exists email_verified     boolean not null default false,
  add column if not exists first_name         text;

comment on column public.sanaku_prospects.draft_subject is
  'Subject line awaiting review. Cleared when the touch sends.';
comment on column public.sanaku_prospects.draft_body is
  'Plain-text body awaiting review. Plain text on purpose - it delivers better than HTML from a cold domain.';
comment on column public.sanaku_prospects.draft_step is
  '1 opener, 2 follow-up (day 3), 3 breakup (day 8). Which touch this draft is for.';
comment on column public.sanaku_prospects.draft_edited is
  'True when Ismail changed the text before approving. The signal for whether the generated voice is trusted yet - if this stays true, the prompt is wrong.';
comment on column public.sanaku_prospects.email_verified is
  'Only a verified address may be sent to. Defaults false, so nothing is emailable until something deliberately proves the address - a scraped info@ must never qualify by accident.';
comment on column public.sanaku_prospects.first_name is
  'Given name alone, for the salutation. contact_name holds the full name and is not safe to greet with.';

-- ----------------------------------------------------------------------------
-- The widened state machine
-- ----------------------------------------------------------------------------
alter table public.sanaku_prospects drop constraint if exists sanaku_prospects_status_check;
alter table public.sanaku_prospects add constraint sanaku_prospects_status_check
  check (status = any (array[
    'new',           -- W1 wrote it
    'queued',        -- Ismail approved the PROSPECT (dashboard)
    'draft_review',  -- W2 drafted an email; awaiting a read
    'approved',      -- Ismail approved the EMAIL; send may fire
    'skipped',       -- Ismail rejected this draft; no send, no retry
    'contacted',     -- an email has gone out (kept, not renamed to 'sent')
    'replied',       -- W2b
    'demo_booked',   -- W3
    'won',
    'lost',          -- W2, after silence past the breakup
    'dnc'            -- W2b, opt-out
  ]));

-- The send half polls for approved drafts; the dashboard lists what needs
-- reading. Both want the same shape.
create index if not exists sanaku_prospects_review_idx
  on public.sanaku_prospects (status, draft_generated_at desc);

-- ----------------------------------------------------------------------------
-- The send ramp, recorded where both n8n and the dashboard can see it
-- ----------------------------------------------------------------------------
-- A cold domain that opens at volume gets filtered and does not recover. The
-- cap lives in a table rather than the workflow so it can be raised without a
-- redeploy, and so the dashboard can show today's remaining allowance.
create table if not exists public.sanaku_send_budget (
  day          date primary key default current_date,
  cap          integer not null default 15,
  sent         integer not null default 0,
  updated_at   timestamptz not null default now()
);

comment on table public.sanaku_send_budget is
  'One row per day. cap is the warm-up ceiling for that day; sent is incremented by W2 after each successful send. W2 refuses to send when sent >= cap.';

alter table public.sanaku_send_budget enable row level security;
revoke all on public.sanaku_send_budget from anon;
drop policy if exists send_budget_staff_all on public.sanaku_send_budget;
create policy send_budget_staff_all on public.sanaku_send_budget
  for all to authenticated
  using ((select public.sanaku_is_staff()))
  with check ((select public.sanaku_is_staff()));

-- Atomic claim of one send slot. Returns true if the caller may send.
--
-- A SELECT-then-UPDATE in the workflow would let two concurrent executions read
-- the same count and both send, which is exactly how a warm-up ramp gets
-- quietly exceeded. This does it in one statement.
create or replace function public.sanaku_claim_send_slot()
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare ok boolean;
begin
  insert into public.sanaku_send_budget (day) values (current_date)
    on conflict (day) do nothing;

  update public.sanaku_send_budget
     set sent = sent + 1, updated_at = now()
   where day = current_date and sent < cap
  returning true into ok;

  return coalesce(ok, false);
end $$;

revoke execute on function public.sanaku_claim_send_slot() from public, anon;
grant execute on function public.sanaku_claim_send_slot() to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select status, count(*) from sanaku_prospects group by 1;
--   select * from sanaku_send_budget;
--
--   -- claim until it refuses; expect true 15 times then false
--   select public.sanaku_claim_send_slot();
--
--   -- nothing is emailable until something verifies an address:
--   select count(*) filter (where email_verified) as verified,
--          count(*) filter (where contact_email is not null) as have_address
--     from sanaku_prospects;
