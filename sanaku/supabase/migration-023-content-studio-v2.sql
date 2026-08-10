-- ============================================================================
-- Migration 023 - the studio grows a memory and an editorial brain
--
-- V1 was one LLM call: brand brain in, finished post out. It produced correct,
-- on-message, forgettable writing - because nothing in it knew what had already
-- been said, and nothing established a POINT OF VIEW before writing prose.
--
-- The Sydney pipeline solves this with two things V1 lacked, and this migration
-- adds the storage both need:
--
--   1. A STORY ENGINE that runs first and decides what today is about, read by
--      a second pass that writes from it. Sydney: mood/location/events/narrative
--      -> captions. Here: thesis/why-now/bottleneck -> the item itself.
--
--   2. A MEMORY that survives the run. Sydney extracts durable facts after each
--      post and feeds them back in forever, which is why her feed reads like a
--      person rather than a random generator. Here the equivalent is knowing
--      which arguments are spent, which analogies are worn out, and which
--      openers have been used - so draft 40 does not re-run draft 3.
--
-- Cadence changes too: three DRAFTS a day, seven days a week, of which Ismail
-- publishes what he likes. So the three must be genuinely different from each
-- other, not three phrasings of one idea - which is what draft_group and the
-- angle memory are for.
--
-- Safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- content_memory - what the studio has learned and used
-- ----------------------------------------------------------------------------
-- Deliberately the same shape as sydney_memory (category/key/value, upserted on
-- conflict): it is a proven shape, and the value is in the discipline that a
-- memory row must be short, stable and worth keeping forever.
create table if not exists public.content_memory (
  id          uuid primary key default gen_random_uuid(),
  category    text not null,
  key         text not null,
  value       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (category, key)
);

comment on table public.content_memory is
  'Long-term memory for the content studio. Categories: angle (arguments already made), analogy (images/comparisons already used), opener (hook patterns already used), fact (durable claims cleared for reuse), reaction (what landed). Upserted on (category, key).';

-- Reuse the existing touch trigger pattern rather than inventing a new one.
create or replace function public.content_memory_touch() returns trigger
  language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_content_memory_touch on public.content_memory;
create trigger trg_content_memory_touch before update on public.content_memory
  for each row execute function public.content_memory_touch();

-- ----------------------------------------------------------------------------
-- content_queue - what the angle engine decided, carried onto the item
-- ----------------------------------------------------------------------------
-- `angle` and `audience` already exist from the original table and are reused
-- rather than duplicated. These are the fields V1 had nowhere to put, which is
-- part of why its output had no point of view to hold on to.
alter table public.content_queue
  add column if not exists thesis       text,
  add column if not exists why_now      text,
  add column if not exists source_title text,
  add column if not exists source_url   text,
  add column if not exists draft_group  uuid;

comment on column public.content_queue.thesis is
  'The one sentence this item argues, decided by the angle engine BEFORE any prose was written. If an item cannot state its thesis it should not have been generated.';
comment on column public.content_queue.why_now is
  'Why this is worth saying today rather than any other day - a trigger, a rule change, a season. Null means evergreen, which is allowed but should be the minority.';
comment on column public.content_queue.source_title is
  'Headline of the real trigger behind the item, when there was one. Shown in the Marketing tab so a claim can be checked before it is published.';
comment on column public.content_queue.source_url is
  'Link to that trigger. Never auto-inserted into the post - it is there so Ismail can verify the claim, and cite it himself if he wants to.';
comment on column public.content_queue.draft_group is
  'The three drafts generated in one morning share this id. Lets the tab show them as a set of alternatives to choose between rather than three unrelated items.';

create index if not exists content_queue_draft_group_idx
  on public.content_queue (draft_group, created_at desc);

-- ----------------------------------------------------------------------------
-- RLS - same rule as everything else: staff only
-- ----------------------------------------------------------------------------
alter table public.content_memory enable row level security;

revoke all on public.content_memory from anon;

drop policy if exists content_memory_staff_all on public.content_memory;
create policy content_memory_staff_all on public.content_memory
  for all to authenticated
  using ((select public.sanaku_is_staff()))
  with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select category, count(*) from content_memory group by 1;
--   -- empty on first run; fills as the studio publishes
--
--   select draft_group, count(*), array_agg(content_type)
--     from content_queue where draft_group is not null group by 1;
--   -- expect 3 per group once the new generator has run
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'content_memory' and grantee = 'anon';
--   -- expect no rows
