-- ============================================================================
-- Migration 020 - a phone-reveal correlation key that cannot lose precision
--
-- Confirmed live 2026-08: Apollo's own /people/match and /people/bulk_match
-- responses return the async phone-reveal request_id as an UNQUOTED JSON
-- number - e.g. "request_id":4832958319159879000, no surrounding quotes.
-- That value is a signed 64-bit integer, 18-20 digits, far past what a
-- standard JSON/JS number can represent exactly (~15-16 significant
-- digits). Proved with raw response bytes that this workflow's own code
-- preserves whatever digits it receives byte-for-byte from extraction
-- through storage through the outgoing poll URL - the corruption is
-- already present in the text Apollo sends, before this pipeline ever
-- touches it. Ten separate phone reveals, all requested normally, all
-- came back from Apollo's own poll endpoint as "request_id_unknown" -
-- Apollo's serializer had already rounded the id before the response
-- left their server, so the true id was unrecoverable from the client
-- side by any means, string-extraction included.
--
-- The fix is to stop depending on that number at all. Apollo can PUSH a
-- completed phone reveal to a webhook instead of us polling for it by
-- id - and the safe way to match that push back to the right prospect is
-- the Apollo PERSON id, a 24-character hex string (like an organization
-- id or a person id anywhere else in this pipeline) that is never a
-- large integer and so is never subject to this bug. This column is
-- that correlation key.
--
-- Safe to run more than once.
-- ============================================================================

alter table sanaku_prospects add column if not exists apollo_person_id text;

comment on column sanaku_prospects.apollo_person_id is
  'Apollo''s person id (24-char hex) for this row''s named contact, when one was found via Apollo search. A safe correlation key - unlike phone_reveal_request_id (a signed 64-bit int Apollo sometimes returns unquoted and already rounded), this always round-trips exactly. Used to match an incoming phone-reveal webhook push back to the correct row, since polling by request_id cannot be trusted for large ids.';

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select count(*) filter (where apollo_person_id is not null) as have_apollo_id,
--          count(*) as total
--     from sanaku_prospects where contact_name is not null;
