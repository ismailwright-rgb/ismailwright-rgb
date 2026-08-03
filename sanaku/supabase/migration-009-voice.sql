-- ============================================================================
-- Migration 009 - voice agent leads, and a flag for demo clients
-- Run after migration-008-recovery-addons.sql.
--
-- The catalog has sold AI phone agents since 007 (voice_reception_home and
-- friends) but nothing could record what one of those calls produced: `channel`
-- rejected 'voice', and there was nowhere to keep the recording or transcript.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Let a lead have arrived by voice.
--
--    The constraint was written inline in schema.sql, so Postgres named it.
--    Drop by that name rather than searching pg_constraint - if a hand-edit
--    renamed it, the add below fails loudly instead of silently leaving two
--    checks on the column, one of which still rejects 'voice'.
-- ----------------------------------------------------------------------------
alter table sanaku_client_leads
  drop constraint if exists sanaku_client_leads_channel_check;

alter table sanaku_client_leads
  add constraint sanaku_client_leads_channel_check
  check (channel in ('web_form', 'sms', 'missed_call', 'chat', 'voice'));

-- ----------------------------------------------------------------------------
-- 2. What a voice call leaves behind.
--
--    transcript holds VAPI's turn-by-turn array - [{role, message, ...}] - so
--    the portal can render it as a conversation rather than a wall of text.
--    call_summary is the model's own one-paragraph summary of the call.
--
--    These are readable by the client: the RLS policy on this table is
--    table-level (client_read in migration-004), not a column grant, so a new
--    column is visible to whoever can already read the row. That is deliberate
--    here - the recording of a call to their own business is theirs.
-- ----------------------------------------------------------------------------
alter table sanaku_client_leads
  add column if not exists recording_url    text,
  add column if not exists transcript       jsonb,
  add column if not exists call_summary     text,
  add column if not exists duration_seconds int;

-- ----------------------------------------------------------------------------
-- 3. Mark a client as a demo.
--
--    `status` is constrained to active|paused|churned, so before this there was
--    no way to say "this row is a prop." A demo client left unflagged shows up
--    in Active clients and Monthly retainers on the roster, which is how you end
--    up quoting a prospect a number that includes a fake plumbing company.
-- ----------------------------------------------------------------------------
alter table sanaku_clients
  add column if not exists is_demo boolean not null default false;

commit;
