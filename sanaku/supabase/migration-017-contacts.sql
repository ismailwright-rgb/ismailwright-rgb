-- ============================================================================
-- Migration 017 - tell the person apart from the switchboard
--
-- Every prospect in the table has a contact_phone, and every one of them is
-- the BUSINESS main line. Four places wrote it and none of them wrote a
-- person's number:
--
--   W1 Filter & Dedupe, Apollo path   org.sanitized_phone || org.phone
--   W1 Filter & Dedupe, Places path   the Google Maps listing number
--   W1 Detect & Score                 a tel: link scraped off the homepage
--   W1 Attach Contact                 company.contact_phone || person.phone
--                                     - the org number came FIRST, so even
--                                       when Apollo returned the person's own
--                                       number the front desk won
--
-- So the dashboard could show "Elaine Gorelik, Owner" and the tel: link beside
-- her name still dialled reception. Naming the decision maker is only half the
-- job; the number has to be hers, and where it is not, that has to be visible
-- rather than assumed.
--
-- Three columns, no renames. contact_phone keeps its meaning of "the best
-- number we have for this prospect" so nothing downstream breaks; what changes
-- is that we now record WHOSE number it is and keep the switchboard separately.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects add column if not exists company_phone        text;
alter table sanaku_prospects add column if not exists contact_linkedin_url text;
alter table sanaku_prospects add column if not exists contact_phone_source text;
alter table sanaku_prospects add column if not exists contact_authority     text;

comment on column sanaku_prospects.company_phone is
  'The business main line. Always the switchboard - never assume a person answers it.';
comment on column sanaku_prospects.contact_linkedin_url is
  'Apollo person profile. Open it before dialling to confirm the human is still there.';
comment on column sanaku_prospects.contact_phone_source is
  'Whose number contact_phone is. Only apollo_direct means it reaches the person.';
comment on column sanaku_prospects.contact_authority is
  'How much authority the named contact has. owner/c_suite/partner/marketing can approve; leader and staff route you; none means we have no person at all.';

-- A CHECK rather than an enum: adding a value to an enum cannot run inside a
-- transaction on older Postgres, which would make this file unsafe to re-run
-- as part of a bundle.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sanaku_prospects_phone_source_ck') then
    alter table sanaku_prospects add constraint sanaku_prospects_phone_source_ck
      check (contact_phone_source is null or contact_phone_source in
             ('apollo_direct', 'apollo_company', 'google_places', 'website', 'manual'));
  end if;
end $$;

-- The bands, in the order they matter on a call. 'marketing' is a band rather
-- than a footnote because a Director of Marketing or of Intake owns the
-- missed-call problem at a firm that has outgrown the owner answering the
-- phone - on the live LA query, one firm was reachable through no other role.
-- 'leader' (director of operations, HR, IT) is a real person but routes you
-- rather than buying, and decision_maker stays false for them.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sanaku_prospects_authority_ck') then
    alter table sanaku_prospects add constraint sanaku_prospects_authority_ck
      check (contact_authority is null or contact_authority in
             ('owner', 'c_suite', 'partner', 'marketing', 'leader', 'staff', 'none'));
  end if;
end $$;

-- Backfill. Every existing contact_phone is a main line - no direct dial has
-- ever been revealed, so there is nothing to guess at and nothing is lost.
update sanaku_prospects
   set company_phone = contact_phone
 where company_phone is null
   and contact_phone is not null;

-- Old rows: W1 set decision_maker true for anything Apollo returned, which was
-- as fine-grained as the data then allowed. Nothing recorded WHICH kind, and
-- re-deriving it from a title string here would be guessing at the one thing
-- this column exists to stop guessing at. 'none' where there is no name;
-- everything else waits for the next scrape to say so properly.
update sanaku_prospects
   set contact_authority = 'none'
 where contact_authority is null
   and contact_name is null;

update sanaku_prospects
   set contact_phone_source = case source
         when 'apollo'        then 'apollo_company'
         when 'google_places' then 'google_places'
         else 'manual'
       end
 where contact_phone_source is null
   and contact_phone is not null;

-- The follow-up queue lists its columns explicitly, so new ones are invisible
-- to it until named here. Calling from this view without knowing whether the
-- number reaches the person is the exact problem this migration exists for.
--
-- DROP, not CREATE OR REPLACE: replace can only append columns, never insert
-- one, and contact_title belongs beside contact_name rather than tacked on the
-- end. Caught by re-running the chain - "cannot change name of view column
-- contact_phone to contact_title" aborts the whole paste at this line.
drop view if exists v_followups_due;
create view v_followups_due as
select
  id, company_name, vertical, tier, intent_score, status,
  contact_name, contact_title, contact_authority, contact_phone, contact_email,
  company_phone, contact_phone_source, contact_linkedin_url, decision_maker,
  next_action, next_action_at, last_activity_at
from sanaku_prospects
where next_action_at is not null
  and next_action_at <= now()
  and do_not_contact = false
  and status not in ('won', 'lost', 'dnc')
order by next_action_at asc;

-- Dropping the view threw away its security_invoker setting, and a view without
-- it runs with OWNER rights - which is an RLS bypass, the exact hole
-- migration-004 was written to close. RUN-THIS-NOW.sql sets this in a loop that
-- has already run by the time this file executes, so it does not come back on
-- its own. Re-apply it here, next to the drop that lost it.
alter view v_followups_due set (security_invoker = on);

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
-- Who we would actually reach, by source of the number:
--
--   select coalesce(contact_phone_source, 'none') as number_reaches,
--          count(*),
--          count(*) filter (where contact_name is not null) as named_contact
--     from sanaku_prospects group by 1 order by 2 desc;
--
-- Anything other than apollo_direct means: dial the main line and ask for them.
