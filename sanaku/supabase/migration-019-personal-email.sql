-- ============================================================================
-- Migration 019 - a personal email, kept apart from the one we send from
--
-- Apollo's reveal_personal_emails is a normal field on the same call that
-- already reveals the business email - verified live before writing this,
-- along with the thing that actually matters here: it is billed from the
-- SAME lead_credit pool as the match call itself, not a new one (confirmed
-- by reading the account's credit usage before and after a real call). So
-- unlike phone, there is no separate budget to manage - it can be requested
-- on every reveal that already happens.
--
-- What it is NOT is reliable. Two real owners checked live both came back
-- with an empty personal_emails array - Apollo's coverage here is thin.
-- Worth having when it exists; not something to promise will usually exist.
--
-- contact_email_personal is a NEW, separate column - it does not replace or
-- merge into contact_email. That column is read by W2's automated cold-email
-- sender, which runs unattended on a schedule from Sanaku's own sending
-- identity - the same one client statements and portal invites go out on.
-- Automatically routing cold outreach at a personal inbox from that shared
-- identity is a deliverability decision with consequences for every client's
-- email, not just this one send, so it stays a column staff can SEE and
-- choose to use by hand, not one the automation reaches for on its own.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects add column if not exists contact_email_personal text;

comment on column sanaku_prospects.contact_email_personal is
  'Personal email from Apollo, when it has one on file (often does not). Display only - W2''s automated sender reads contact_email, never this column, on purpose: it shares a sending identity with client statements and portal invites.';

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select count(*) filter (where contact_email_personal is not null) as have_personal,
--          count(*) as total
--     from sanaku_prospects where contact_name is not null;
