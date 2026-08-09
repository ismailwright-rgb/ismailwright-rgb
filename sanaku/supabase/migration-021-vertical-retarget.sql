-- ============================================================================
-- Migration 021 - widen sanaku_prospects.vertical for the retargeted verticals
--
-- W1 stops sourcing 'medical' and 'home_services' and starts sourcing four
-- new verticals: accounting_tax, therapy, financial_advisory, family_office
-- (personal injury law, already the 'law_firm' key, is unchanged). The
-- common thread across the new target list, per the actual goal behind this
-- change: privacy-regulated firms - businesses where a mishandled client
-- relationship means mishandled private client information (tax/financial
-- records, clinical records, estate/personal wealth data).
--
-- WIDEN the existing CHECK constraint, don't replace it - ~67 existing
-- historical rows still carry 'medical'/'home_services' and must stay
-- valid; the workflow itself is what stops generating new ones for those
-- two, not the schema.
--
-- IMPORTANT: run this SELECT first and confirm the constraint name below
-- actually matches what's in your project - Postgres auto-names an inline
-- column check as "<table>_<column>_check", but don't take that on faith:
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'sanaku_prospects'::regclass
--      and pg_get_constraintdef(oid) ilike '%vertical%';
--
-- If the name that comes back is different from
-- sanaku_prospects_vertical_check, edit the DROP line below to match before
-- running the rest of this file - a DROP that misses the real constraint
-- leaves the OLD 3-value check in place alongside a new one, and every
-- insert for a new vertical will keep failing.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects drop constraint if exists sanaku_prospects_vertical_check;
alter table sanaku_prospects add constraint sanaku_prospects_vertical_check
  check (vertical is null or vertical in
         ('law_firm', 'medical', 'home_services',
          'accounting_tax', 'therapy', 'financial_advisory', 'family_office'));

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select vertical, count(*) from sanaku_prospects group by 1 order by 2 desc;
-- Should show the 3 legacy verticals with their existing counts untouched,
-- and accept new rows in any of the 4 new verticals once W1 runs again.
