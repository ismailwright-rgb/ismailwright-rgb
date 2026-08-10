-- ============================================================================
-- Migration 022 - the LinkedIn content studio: schema, and an RLS repair
--
-- Two unrelated-looking things live in one file because they touch the same
-- two tables and the second one must not ship after the first.
--
-- ---------------------------------------------------------------------------
-- PART 1 - RLS repair. Read this part before running anything.
-- ---------------------------------------------------------------------------
-- content_queue and brand_brain were both created outside this migrations
-- directory (no file in supabase/ creates either one), and both were left
-- open in a way the rest of the schema is not:
--
--   content_queue  had RLS on, but three policies - cq_anon_read,
--                  cq_anon_update, cq_anon_delete - all granted to role
--                  `public` with a `true` qualifier, plus table grants to
--                  `anon`. `public` includes `anon`. The anon key is compiled
--                  into the deployed dashboard bundle and is readable by
--                  anyone who views source. So every row was world-readable,
--                  world-editable and world-deletable.
--
--   brand_brain    had one policy, operator_all, granted to `authenticated`
--                  with `true`. Client portal users are real Supabase auth
--                  users (that is the whole point of sanaku_is_staff), so a
--                  client could read the full ICP, objection rebuttals and
--                  positioning - and write to them.
--
-- Neither has leaked: content_queue is empty, and there is exactly one client
-- user today. Both were almost certainly deliberate at the time - the queue
-- was designed to be read by a standalone keyless HTML page. That design is
-- being replaced here by a tab inside the authenticated staff dashboard, so
-- the anon door has nothing left behind it.
--
-- This matters more for Sanaku than it would for most projects. The product
-- is "AI that never leaves your building". A marketing studio for that
-- product cannot itself sit on a world-writable table.
--
-- After this migration both tables follow the same rule as everything else in
-- migration-004: staff only, via sanaku_is_staff().
--
-- The n8n generator is unaffected - it authenticates with the service_role
-- key, and service_role bypasses RLS entirely.
--
-- ---------------------------------------------------------------------------
-- PART 2 - the studio schema
-- ---------------------------------------------------------------------------
-- content_queue as it stands carries one post and one image: angle, audience,
-- post_text, image_prompt, image_url. The studio produces six more shapes -
-- carousels, polls, articles, newsletter editions, featured assets - so the
-- table grows the columns those need. Nothing existing is dropped or renamed;
-- the table has zero rows, so there is no data to migrate either way.
--
-- ---------------------------------------------------------------------------
-- RUN ORDER - this file first, ON ITS OWN, then seed-brand-brain-linkedin.sql
-- ---------------------------------------------------------------------------
-- This file adds values to the `vertical` enum. Postgres will not let a new
-- enum value be USED in the same transaction that added it. The seed file
-- inserts rows tagged with those new verticals, so it has to be a separate
-- statement batch. Running both at once fails with "unsafe use of new value".
--
-- Safe to run more than once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
-- The four new verticals from the retarget. personal_injury_law is already
-- here and is unchanged. The three that are now off the target list
-- (med_spa, dental, real_estate) stay defined - historical rows in leads and
-- playbook still reference them, and an enum value cannot be removed anyway.
--
-- Note for later: sanaku_prospects.vertical is a TEXT column with its own
-- CHECK constraint and a DIFFERENT vocabulary ('law_firm', 'medical', ...),
-- widened by migration-021. These two lists are not the same and are not
-- being unified here. The studio joins to brand_brain, so it speaks
-- brand_brain's language. See the note at the bottom of this file.
alter type public.vertical add value if not exists 'accounting_tax';
alter type public.vertical add value if not exists 'therapy';
alter type public.vertical add value if not exists 'financial_advisory';
alter type public.vertical add value if not exists 'family_office';

-- Type names deliberately differ from the column names they serve, matching
-- brain_kind/kind and brain_status/status elsewhere in this schema.
do $$ begin
  create type public.content_kind as enum
    ('post', 'carousel', 'poll', 'article', 'newsletter', 'featured', 'video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.content_status as enum ('queued', 'approved', 'posted');
exception when duplicate_object then null; end $$;

comment on type public.content_kind is
  'LinkedIn formats the studio produces. video is defined but not generated yet - Phase 2, blocked on Alexya animation.';

-- ----------------------------------------------------------------------------
-- content_queue - the new columns
-- ----------------------------------------------------------------------------
alter table public.content_queue
  add column if not exists content_type    public.content_kind not null default 'post',
  add column if not exists title           text,
  add column if not exists body            text,
  add column if not exists slides          jsonb,
  add column if not exists poll_question   text,
  add column if not exists poll_options    jsonb,
  add column if not exists target_vertical public.vertical,
  add column if not exists bottleneck      text;

comment on column public.content_queue.content_type is
  'Which LinkedIn format this row is. Decides how the Marketing tab renders it and what the post pack contains.';
comment on column public.content_queue.title is
  'Article headline, newsletter edition title, or featured asset name. Null for plain posts.';
comment on column public.content_queue.body is
  'Long-form copy: article body or newsletter body. Plain posts keep using post_text - body is not a rename of it.';
comment on column public.content_queue.slides is
  'Carousel slides, ordered. Array of {"text": "...", "image_url": "..."} - image_url is optional per slide, so a text-only carousel is valid. Order in the array IS slide order; the post pack names files from the index.';
comment on column public.content_queue.poll_options is
  'Array of 2-4 option strings, e.g. ["Yes","No","Not sure"]. LinkedIn caps polls at 4 options.';
comment on column public.content_queue.target_vertical is
  'Which audience this item speaks to. Same enum as brand_brain.vertical so the two join directly.';
comment on column public.content_queue.bottleneck is
  'The one bottleneck this item addresses. Free text on purpose, not an enum: the positioning is meant to evolve in the brand brain without a schema change. Canonical five today - missed_calls, data_exposure, compliance_pressure, loss_of_control, paperwork_load.';

-- ----------------------------------------------------------------------------
-- post_text must become nullable
-- ----------------------------------------------------------------------------
-- It is currently NOT NULL, from when a queue row could only ever be one text
-- post. An article carries its copy in body, a poll in poll_question, a
-- carousel in slides - none of them necessarily have post_text at all, so the
-- generator's INSERT would fail the not-null check on every format except
-- 'post'. Dropping the constraint is required, not cosmetic.
--
-- The per-format CHECK below replaces what NOT NULL was doing, and does it
-- properly: each format must carry its OWN payload, rather than every format
-- being forced to carry the one that only 'post' needs.
alter table public.content_queue alter column post_text drop not null;

-- Shape guards. Cheap, and they catch a generator that emits a bare string or
-- an object where an array belongs - which is the likely failure mode when a
-- free model drifts off its output format.
alter table public.content_queue drop constraint if exists content_queue_slides_is_array;
alter table public.content_queue add constraint content_queue_slides_is_array
  check (slides is null or jsonb_typeof(slides) = 'array');

alter table public.content_queue drop constraint if exists content_queue_poll_options_shape;
alter table public.content_queue add constraint content_queue_poll_options_shape
  check (poll_options is null or
         (jsonb_typeof(poll_options) = 'array' and jsonb_array_length(poll_options) between 2 and 4));

-- Each format must carry the payload its own format needs. This is what makes
-- a half-generated row fail loudly at insert time instead of showing up in the
-- Marketing tab as an empty card that cannot be posted.
--
-- 'video' is intentionally unconstrained - nothing generates it yet, and
-- guessing its required shape now would only have to be redone in Phase 2.
alter table public.content_queue drop constraint if exists content_queue_payload_by_type;
alter table public.content_queue add constraint content_queue_payload_by_type check (
  case content_type
    when 'post'       then post_text is not null
    when 'carousel'   then slides is not null and jsonb_array_length(slides) > 0
    when 'poll'       then poll_question is not null and poll_options is not null
    when 'article'    then body is not null and title is not null
    when 'newsletter' then body is not null and title is not null
    when 'featured'   then title is not null
    else true
  end
);

-- ----------------------------------------------------------------------------
-- content_queue.status - text -> enum
-- ----------------------------------------------------------------------------
-- The column defaults to the string 'draft', which is not one of the three
-- states the studio uses. The table is empty so nothing actually converts,
-- but the USING clause maps defensively rather than assuming that stays true.
-- Guarded on the current type so a second run is a no-op instead of an error.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'content_queue'
       and column_name = 'status' and udt_name <> 'content_status'
  ) then
    alter table public.content_queue alter column status drop default;
    alter table public.content_queue alter column status type public.content_status
      using (case when status in ('queued', 'approved', 'posted') then status
                  else 'queued' end)::public.content_status;
    alter table public.content_queue alter column status set default 'queued';
    alter table public.content_queue alter column status set not null;
  end if;
end $$;

comment on column public.content_queue.status is
  'queued -> approved -> posted. approved is the human gate: nothing is exportable as a post pack until Ismail approves it.';

-- The Marketing tab's default view is "one format at a time, newest first".
create index if not exists content_queue_status_type_created_idx
  on public.content_queue (status, content_type, created_at desc);

-- ----------------------------------------------------------------------------
-- brand_brain.channel
-- ----------------------------------------------------------------------------
-- Reuses the existing public.channel enum (email, sms, call, linkedin) rather
-- than inventing a parallel one.
--
-- NULL means "applies everywhere" - which is what all 12 existing rows are,
-- so they need no backfill and keep working for outbound exactly as before.
-- LinkedIn-specific rows get channel = 'linkedin'. Retrieval then filters
-- `channel is null or channel = 'linkedin'`.
--
-- This is what keeps the two voices from colliding. The outbound rule "How
-- Sanaku talks" (avoid the word AI - it reads as a buzzword in cold email)
-- stays live and untouched at channel NULL... except it must NOT apply to
-- LinkedIn, where naming AI is the entire point of the positioning. So that
-- one row gets pinned to the channels it was actually written for, below.
alter table public.brand_brain
  add column if not exists channel public.channel;

comment on column public.brand_brain.channel is
  'Which channel this brain row governs. NULL = all channels. Set it only when a row is genuinely channel-specific - a LinkedIn voice rule, or an outbound-email-only phrasing rule.';

create index if not exists brand_brain_channel_vertical_idx
  on public.brand_brain (channel, vertical, status);

-- Pin the outbound voice rule to outbound. It says not to say "AI", which is
-- correct for cold email and wrong for a personal profile whose whole subject
-- is privacy-safe AI. Left at NULL it would contradict the LinkedIn voice.
-- Matched on title rather than id so this is portable; no-op if absent.
update public.brand_brain
   set channel = 'email'
 where title = 'How Sanaku talks'
   and channel is null;

-- ----------------------------------------------------------------------------
-- RLS - see PART 1 above
-- ----------------------------------------------------------------------------
drop policy if exists cq_anon_read   on public.content_queue;
drop policy if exists cq_anon_update on public.content_queue;
drop policy if exists cq_anon_delete on public.content_queue;

revoke all on public.content_queue from anon;

alter table public.content_queue enable row level security;

drop policy if exists content_queue_staff_all on public.content_queue;
create policy content_queue_staff_all on public.content_queue
  for all to authenticated
  using ((select public.sanaku_is_staff()))
  with check ((select public.sanaku_is_staff()));

-- brand_brain: was any authenticated user, including client portal users.
drop policy if exists operator_all on public.brand_brain;

revoke all on public.brand_brain from anon;

alter table public.brand_brain enable row level security;

drop policy if exists brand_brain_staff_all on public.brand_brain;
create policy brand_brain_staff_all on public.brand_brain
  for all to authenticated
  using ((select public.sanaku_is_staff()))
  with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
-- 1. No anon reachability left on either table. Both should return no rows:
--
--   select tablename, policyname, roles::text
--     from pg_policies
--    where tablename in ('content_queue','brand_brain')
--      and roles::text like '%anon%' or roles::text = '{public}';
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_name in ('content_queue','brand_brain') and grantee = 'anon';
--
-- 2. Staff policy is in place - expect exactly one row per table, cmd = ALL:
--
--   select tablename, policyname, cmd from pg_policies
--    where tablename in ('content_queue','brand_brain');
--
-- 3. Columns and types landed:
--
--   select column_name, udt_name, is_nullable, column_default
--     from information_schema.columns
--    where table_name = 'content_queue' order by ordinal_position;
--
-- 4. The four new verticals exist:
--
--   select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--    where t.typname = 'vertical' order by e.enumsortorder;
--
-- 5. Then, and only then, run seed-brand-brain-linkedin.sql.
--
-- ----------------------------------------------------------------------------
-- Known inconsistency, deliberately NOT fixed here
-- ----------------------------------------------------------------------------
-- There are two vertical vocabularies in this database:
--
--   public.vertical (enum)          personal_injury_law, med_spa, dental,
--                                   real_estate, home_services, other
--                                   + the four added above
--                                   used by: brand_brain, leads, playbook,
--                                   lead_classifications, content_queue
--
--   sanaku_prospects.vertical (text + CHECK)
--                                   law_firm, medical, home_services
--                                   ( + 4 more once migration-021 is applied )
--
-- 'law_firm' and 'personal_injury_law' are the same audience under two names.
-- Unifying them means rewriting W1's scraper output and backfilling ~67 rows,
-- which has nothing to do with the content studio and should not ride along
-- with it. Flagged so the next person does not assume they match.
--
-- Also worth knowing: as of this migration, migration-021 has NOT been applied
-- to the live database - sanaku_prospects still carries the original 3-value
-- CHECK. That is a separate outstanding item, not caused or fixed by this file.
