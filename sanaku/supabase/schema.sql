-- ============================================================================
-- SANAKU - Phase 0 schema
-- ============================================================================
-- Run in the Supabase SQL editor. Idempotent - safe to re-run.
--
-- Access model:
--   * n8n talks to PostgREST with the service_role key -> bypasses RLS.
--   * The dashboard uses the anon key + Supabase Auth (email/password login).
--     RLS is ENABLED on every table with a single "authenticated users get
--     full access" policy - you are the only user in this project. If you
--     ever add users, tighten these policies before inviting anyone.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- sanaku_prospects
-- ----------------------------------------------------------------------------
-- NOTE (addition to spec): a normalized "domain" column is the dedupe/upsert
-- key (website_url alone is too messy to be unique - http/https/www/paths).
-- W1 writes it lowercase without "www.".
create table if not exists sanaku_prospects (
  id                uuid primary key default gen_random_uuid(),
  company_name      text not null,
  vertical          text check (vertical in ('law_firm', 'medical', 'home_services')),
  website_url       text,
  domain            text,
  contact_name      text,
  contact_title     text,
  contact_email     text,
  contact_phone     text,
  decision_maker    boolean default false,
  city              text,
  state             text,
  employee_count    int,
  ai_maturity_score int check (ai_maturity_score between 0 and 2),
  intent_score      int check (intent_score between 0 and 100),
  tech_stack        text[],
  signals           jsonb default '{}'::jsonb,
  tier              int check (tier in (1, 2, 3)),
  status            text not null default 'new' check (status in
                      ('new', 'queued', 'contacted', 'replied', 'demo_booked', 'won', 'lost', 'dnc')),
  source            text check (source in ('apollo', 'google_places', 'manual')),
  first_seen        timestamptz default now(),
  last_contacted    timestamptz,
  do_not_contact    boolean not null default false,
  notes             text
);

-- NOTE: must be a FULL unique index - PostgREST upserts (?on_conflict=domain)
-- cannot use a partial index for conflict detection (Postgres limitation).
-- Multiple NULL domains remain allowed either way.
create unique index if not exists sanaku_prospects_domain_key
  on sanaku_prospects (domain);
create index if not exists sanaku_prospects_phone_idx on sanaku_prospects (contact_phone);
create index if not exists sanaku_prospects_status_idx on sanaku_prospects (status);
create index if not exists sanaku_prospects_tier_intent_idx on sanaku_prospects (tier, intent_score desc);

-- ----------------------------------------------------------------------------
-- sanaku_conversations
-- ----------------------------------------------------------------------------
create table if not exists sanaku_conversations (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid references sanaku_prospects (id) on delete cascade,
  channel       text check (channel in ('sms', 'email', 'call')),
  direction     text check (direction in ('outbound', 'inbound')),
  body          text,
  sent_at       timestamptz default now(),
  sequence_step int,
  sentiment     text check (sentiment in ('positive', 'neutral', 'negative', 'opt_out'))
);

create index if not exists sanaku_conversations_prospect_idx
  on sanaku_conversations (prospect_id, sent_at desc);

-- ----------------------------------------------------------------------------
-- sanaku_demos
-- ----------------------------------------------------------------------------
create table if not exists sanaku_demos (
  id                  uuid primary key default gen_random_uuid(),
  prospect_id         uuid references sanaku_prospects (id) on delete set null,
  scheduled_for       timestamptz,
  gcal_event_id       text,
  stated_pain         text,
  monthly_lead_volume int,
  est_lead_value      numeric,
  est_monthly_loss    numeric,
  showed              boolean,
  outcome             text check (outcome in ('won', 'lost', 'no_show', 'follow_up'))
);

create index if not exists sanaku_demos_scheduled_idx on sanaku_demos (scheduled_for);

-- ----------------------------------------------------------------------------
-- sanaku_clients
-- ----------------------------------------------------------------------------
create table if not exists sanaku_clients (
  id                  uuid primary key default gen_random_uuid(),
  prospect_id         uuid references sanaku_prospects (id) on delete set null,
  company_name        text not null,
  vertical            text,
  status              text not null default 'active' check (status in ('active', 'paused', 'churned')),
  onboarded_at        date,
  -- white-label branding
  brand_name          text,
  brand_logo_url      text,
  brand_primary_color text,
  brand_accent_color  text,
  sending_domain      text,
  sending_number      text,
  -- commercial terms
  pricing_model       text check (pricing_model in ('retainer_plus_rev_share', 'retainer_plus_per_lead', 'flat')),
  monthly_retainer    numeric,
  rev_share_pct       numeric,
  per_lead_fee        numeric,
  workflow_enabled    boolean not null default true
);

-- ----------------------------------------------------------------------------
-- sanaku_client_leads  (the billing meter)
-- ----------------------------------------------------------------------------
create table if not exists sanaku_client_leads (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references sanaku_clients (id) on delete cascade,
  captured_at    timestamptz default now(),
  name           text,
  phone          text,
  email          text,
  channel        text check (channel in ('web_form', 'sms', 'missed_call', 'chat')),
  after_hours    boolean,
  qualified      boolean,
  lead_score     int,
  outcome        text check (outcome in ('booked', 'no_response', 'converted', 'lost')),
  reported_value numeric,
  billable       boolean not null default true
);

create index if not exists sanaku_client_leads_client_idx
  on sanaku_client_leads (client_id, captured_at desc);

-- ----------------------------------------------------------------------------
-- sanaku_change_requests
-- ----------------------------------------------------------------------------
create table if not exists sanaku_change_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references sanaku_clients (id) on delete cascade,
  submitted_at timestamptz default now(),
  request      text,
  priority     text check (priority in ('low', 'normal', 'urgent')),
  status       text default 'open' check (status in ('open', 'in_progress', 'done')),
  resolved_at  timestamptz
);

-- ----------------------------------------------------------------------------
-- sanaku_billing
-- ----------------------------------------------------------------------------
create table if not exists sanaku_billing (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references sanaku_clients (id) on delete cascade,
  period_start    date,
  period_end      date,
  retainer_due    numeric,
  leads_captured  int,
  converted_value numeric,
  rev_share_due   numeric,
  total_due       numeric,
  status          text default 'draft' check (status in ('draft', 'sent', 'paid', 'overdue')),
  paid_at         timestamptz
);

-- ----------------------------------------------------------------------------
-- sanaku_errors
-- ----------------------------------------------------------------------------
create table if not exists sanaku_errors (
  id          uuid primary key default gen_random_uuid(),
  workflow    text,
  prospect_id uuid,
  error       text,
  payload     jsonb,
  occurred_at timestamptz default now()
);

create index if not exists sanaku_errors_time_idx on sanaku_errors (occurred_at desc);

-- ----------------------------------------------------------------------------
-- v_top_prospects - the outreach queue source
-- ----------------------------------------------------------------------------
create or replace view v_top_prospects as
select *
from sanaku_prospects
where tier = 1
  and status = 'new'
  and do_not_contact = false
order by intent_score desc;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- Service role (n8n) bypasses RLS automatically. The dashboard logs in through
-- Supabase Auth and gets the "authenticated" role. One owner -> full access.
-- Enable RLS on every table. Policies are NOT created here on purpose.
--
-- This file used to create a permissive `owner_all` policy per table
-- (`using (true)` for any authenticated user). Because this file is meant to
-- be re-runnable, re-running it would silently re-open every table to every
-- logged-in user - including client-portal users - undoing the security model.
--
-- All policies now live in migration-004-security.sql. Run that immediately
-- after this file. Until you do, RLS is on with no policies, which denies
-- everything except the service_role key used by n8n.
do $$
declare
  t text;
begin
  foreach t in array array[
    'sanaku_prospects', 'sanaku_conversations', 'sanaku_demos', 'sanaku_clients',
    'sanaku_client_leads', 'sanaku_change_requests', 'sanaku_billing', 'sanaku_errors'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
  end loop;
end $$;

-- Views run with their OWNER's rights unless told otherwise, which bypasses
-- RLS entirely. Every view in this project must set security_invoker.
alter view v_top_prospects set (security_invoker = on);

-- Anonymous (not logged in) gets nothing: no policies for the anon role.
-- To create your dashboard login: Supabase Studio > Authentication > Users >
-- "Add user" with your email + password, and disable public signups
-- (Authentication > Providers > Email > turn off "Enable Signups").
