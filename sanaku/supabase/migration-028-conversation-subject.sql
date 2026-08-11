-- ============================================================================
-- Migration 028 - the column W2s has always tried to write
--
-- W2s's Record The Send builds a conversation row containing `subject`.
-- sanaku_conversations has no such column. Every insert would have failed with
-- 42703, which means: the email leaves, Zoho confirms it, and then logging it
-- 400s. Mark Contacted never runs, the prospect stays 'approved' with its draft
-- intact, and the next scheduled run sends the SAME email to the SAME person
-- again. Every thirty minutes.
--
-- This was never reached before now only because the SMTP send in front of it
-- had never once succeeded. Fixing the transport exposed it - the second defect
-- in a row where a failure downstream of a success would have gone unnoticed.
--
-- The column is added rather than the write removed: the subject is the only
-- part of a sent email that a human scanning the history actually reads, and
-- the dashboard's delivery list shows it.
--
-- Safe to run more than once.
-- ============================================================================

alter table public.sanaku_conversations
  add column if not exists subject text;

comment on column public.sanaku_conversations.subject is
  'Subject line of an outbound email. Null for calls and for inbound replies, where the channel carries no subject worth keeping.';

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select column_name, data_type from information_schema.columns
--    where table_name = 'sanaku_conversations' order by ordinal_position;
--
--   -- the exact insert W2s performs, rolled back:
--   begin;
--   insert into public.sanaku_conversations
--     (prospect_id, direction, channel, subject, body, sequence_step, sent_at)
--   select id, 'outbound', 'email', 'probe', 'probe', 1, now()
--     from public.sanaku_prospects limit 1;
--   rollback;
