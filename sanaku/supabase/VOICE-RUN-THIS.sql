-- ============================================================================
-- SANAKU - VOICE AGENT. RUN THIS ONE FILE.
--
-- Supabase -> SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run more than once. Takes about a second.
--
-- Requires ADDONS-RUN-THIS.sql to have been run already.
--
-- Installs:
--   1. 'voice' as a lead channel, plus the recording, transcript, summary and
--      duration a phone-agent call leaves behind
--   2. is_demo on sanaku_clients, so a demo client stops counting toward
--      Active clients and Monthly retainers
--
-- After running, scroll to the bottom for the verification query.
-- ============================================================================


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


-- ============================================================================
-- VERIFY - expect four new columns on the leads table, is_demo on clients,
-- and 'voice' listed among the allowed channels.
-- ============================================================================
select
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_client_leads'
      and column_name in ('recording_url','transcript','call_summary','duration_seconds')
  ) as new_lead_columns,          -- expect 4
  (select count(*) from information_schema.columns
    where table_name = 'sanaku_clients' and column_name = 'is_demo'
  ) as is_demo_added,             -- expect 1
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'sanaku_client_leads_channel_check'
  ) as channel_rule;              -- must mention 'voice'
