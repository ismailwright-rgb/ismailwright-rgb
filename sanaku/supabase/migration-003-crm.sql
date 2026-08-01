-- ============================================================================
-- Migration 003 - CRM layer: notes, activity tracking, follow-ups
-- Run in the Supabase SQL editor. Idempotent - safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Timestamped notes on a prospect. (prospects.notes stays as the free-text
-- field the scraper and imports write into; this is the human record.)
-- ----------------------------------------------------------------------------
create table if not exists sanaku_notes (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid references sanaku_prospects (id) on delete cascade,
  body        text not null,
  author      text,
  created_at  timestamptz not null default now()
);

create index if not exists sanaku_notes_prospect_idx
  on sanaku_notes (prospect_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Follow-up tracking on prospects
-- ----------------------------------------------------------------------------
alter table sanaku_prospects
  add column if not exists next_action      text,
  add column if not exists next_action_at   timestamptz,
  add column if not exists last_activity_at timestamptz;

create index if not exists sanaku_prospects_next_action_idx
  on sanaku_prospects (next_action_at) where next_action_at is not null;

-- ----------------------------------------------------------------------------
-- Any conversation or note touches the prospect's activity clock, so "who has
-- gone quiet" is answerable without scanning child tables.
-- ----------------------------------------------------------------------------
create or replace function sanaku_touch_activity() returns trigger
language plpgsql as $$
begin
  update sanaku_prospects
     set last_activity_at = greatest(coalesce(last_activity_at, to_timestamp(0)), now())
   where id = new.prospect_id;
  return new;
end;
$$;

drop trigger if exists sanaku_conversations_touch on sanaku_conversations;
create trigger sanaku_conversations_touch
  after insert on sanaku_conversations
  for each row execute function sanaku_touch_activity();

drop trigger if exists sanaku_notes_touch on sanaku_notes;
create trigger sanaku_notes_touch
  after insert on sanaku_notes
  for each row execute function sanaku_touch_activity();

-- ----------------------------------------------------------------------------
-- What needs working today. Excludes finished and suppressed records.
-- ----------------------------------------------------------------------------
create or replace view v_followups_due as
select
  id, company_name, vertical, tier, intent_score, status,
  contact_name, contact_phone, contact_email,
  next_action, next_action_at, last_activity_at
from sanaku_prospects
where next_action_at is not null
  and next_action_at <= now()
  and do_not_contact = false
  and status not in ('won', 'lost', 'dnc')
order by next_action_at asc;

-- RLS on, no policy here: migration-004-security.sql installs the staff-only
-- policy. A permissive policy in this file would be re-applied on any re-run
-- and re-open the table to client-portal users.
alter table sanaku_notes enable row level security;
alter table sanaku_notes force  row level security;
drop policy if exists owner_all on sanaku_notes;
