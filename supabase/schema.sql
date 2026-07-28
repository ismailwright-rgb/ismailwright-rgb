-- ============================================================================
-- AI Prospect Tiering Pipeline - Supabase schema
-- ============================================================================
-- Run this in the Supabase SQL editor (or psql) before importing the n8n
-- workflows. All statements are idempotent - safe to re-run.
--
-- Tables:
--   prospects        - one row per company (unique on normalized domain)
--   suppression_list - opt-outs / deletion requests (GDPR/CCPA + do-not-call)
--   error_log        - errors, skipped records, and run summaries from n8n
--   api_usage        - monthly Apollo credit tracking (enforces free-tier cap)
--   outreach_log     - one row per Vapi outbound call
-- Views:
--   tier1_prospects  - ranked Tier 1 (no AI detected) prospects for the digest
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- prospects
-- ----------------------------------------------------------------------------
-- NOTE: "tier" is a GENERATED column (ai_maturity_score + 1). Never include it
-- in insert/upsert payloads - the n8n "Build Upsert Rows" node omits it.
-- NOTE: "domain" must be pre-normalized (lowercase, no www.) by the workflow;
-- the unique constraint is on the plain column so PostgREST
-- "?on_conflict=domain" upserts work.
create table if not exists prospects (
  id uuid primary key default gen_random_uuid(),
  company_name text not null,
  domain text not null unique,
  website_url text,
  vertical text not null check (vertical in ('personal_injury_law', 'medical_practice', 'home_services')),
  city text,
  state text not null default 'CA',
  contact_name text,
  contact_title text,
  contact_email text,
  contact_phone text,
  employee_count integer,
  ai_maturity_score smallint check (ai_maturity_score between 0 and 2),
  tier smallint generated always as (ai_maturity_score + 1) stored,
  intent_score smallint check (intent_score between 0 and 100),
  signals jsonb not null default '{}'::jsonb,
  source text not null default 'apollo',
  -- GDPR Art. 6(1)(f) / CCPA B2B: business contact data processed under
  -- legitimate interest. See docs/compliance.md.
  lawful_basis text not null default 'legitimate_interest',
  do_not_contact boolean not null default false,
  outreach_status text not null default 'new' check (outreach_status in (
    'new', 'approved', 'calling', 'contacted', 'interested',
    'callback', 'not_interested', 'do_not_call'
  )),
  first_seen timestamptz not null default now(),
  last_updated timestamptz not null default now()
);

create unique index if not exists prospects_email_key
  on prospects (lower(contact_email))
  where contact_email is not null;
create index if not exists prospects_intent_idx on prospects (intent_score desc);
create index if not exists prospects_vertical_idx on prospects (vertical);
create index if not exists prospects_outreach_status_idx on prospects (outreach_status);

create or replace function touch_last_updated() returns trigger
language plpgsql as $$
begin
  new.last_updated := now();
  return new;
end;
$$;

drop trigger if exists prospects_touch on prospects;
create trigger prospects_touch
  before update on prospects
  for each row execute function touch_last_updated();

-- ----------------------------------------------------------------------------
-- suppression_list: opt-outs, do-not-call requests, deletion requests.
-- Checked before enrichment (n8n) and inside the tier1_prospects view.
-- ----------------------------------------------------------------------------
create table if not exists suppression_list (
  id uuid primary key default gen_random_uuid(),
  domain text,
  email text,
  phone text,
  reason text,
  created_at timestamptz not null default now(),
  check (domain is not null or email is not null or phone is not null)
);

create index if not exists suppression_domain_idx on suppression_list (lower(domain));
create index if not exists suppression_email_idx on suppression_list (lower(email));

-- ----------------------------------------------------------------------------
-- error_log: levels - error | skipped | fatal | info (run summaries)
-- ----------------------------------------------------------------------------
create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  workflow text,
  node text,
  level text not null default 'error',
  domain text,
  message text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists error_log_level_idx on error_log (level, created_at desc);

-- ----------------------------------------------------------------------------
-- api_usage: one row per run that spent credits; the enrichment workflow sums
-- the current month at start and skips the run when the cap is reached.
-- ----------------------------------------------------------------------------
create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  month text not null,                       -- 'YYYY-MM'
  provider text not null default 'apollo',
  credits_used integer not null default 0,
  run_at timestamptz not null default now()
);

create index if not exists api_usage_month_idx on api_usage (month, provider);

-- ----------------------------------------------------------------------------
-- outreach_log: one row per Vapi outbound call, updated by the
-- end-of-call-report webhook.
-- ----------------------------------------------------------------------------
create table if not exists outreach_log (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects (id) on delete cascade,
  vapi_call_id text unique,
  status text not null default 'initiated',  -- initiated | completed | failed
  outcome text,                              -- interested | callback | not_interested | voicemail | asked_not_to_call | no_answer
  ended_reason text,
  duration_seconds integer,
  cost numeric(10, 4),
  summary text,
  transcript text,
  recording_url text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists outreach_log_prospect_idx on outreach_log (prospect_id);

-- ----------------------------------------------------------------------------
-- tier1_prospects: what the weekly digest emails. Tier 1 = no AI tooling
-- detected = highest outreach intent.
-- ----------------------------------------------------------------------------
create or replace view tier1_prospects as
select
  p.id,
  p.company_name,
  p.domain,
  p.website_url,
  p.vertical,
  p.city,
  p.contact_name,
  p.contact_title,
  p.contact_email,
  p.contact_phone,
  p.employee_count,
  p.intent_score,
  p.outreach_status,
  p.signals,
  p.last_updated
from prospects p
where p.tier = 1
  and p.do_not_contact = false
  and p.intent_score >= 40
  and not exists (
    select 1
    from suppression_list s
    where (s.domain is not null and lower(s.domain) = lower(p.domain))
       or (s.email is not null and p.contact_email is not null
           and lower(s.email) = lower(p.contact_email))
       or (s.phone is not null and p.contact_phone is not null
           and s.phone = p.contact_phone)
  )
order by p.intent_score desc;
