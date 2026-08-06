-- ============================================================================
-- Migration 002 - pricing and pilot terms
-- Run in the Supabase SQL editor. Idempotent - safe to re-run.
-- ============================================================================

alter table sanaku_clients
  add column if not exists setup_fee          numeric,
  add column if not exists pilot_ends_on      date,     -- free-service window end
  add column if not exists billing_starts_on  date,     -- first retainer charge
  add column if not exists agreement_signed_on date,
  add column if not exists notes              text;

-- Per-lead billing needs a definition of "qualified" agreed up front, and a
-- ceiling so the client can predict their bill.
alter table sanaku_clients
  add column if not exists qualified_definition text,
  add column if not exists per_lead_monthly_cap numeric;

-- ----------------------------------------------------------------------------
-- Guardrail: fee structures that are legally problematic by vertical.
--   medical      -> flat fee ONLY (anti-kickback / fee-splitting exposure)
--   law_firm     -> flat, or retainer + per-lead DELIVERED. Never a share of
--                   fees (ABA Model Rule 5.4 - non-lawyer fee splitting)
--   home_services-> anything, including revenue share
-- Enforced in the database so a late-night onboarding cannot create a
-- structure that a client's counsel would later kill.
-- ----------------------------------------------------------------------------
alter table sanaku_clients drop constraint if exists sanaku_clients_pricing_legal;
alter table sanaku_clients add constraint sanaku_clients_pricing_legal check (
  vertical is null
  or pricing_model is null
  or (vertical = 'medical'       and pricing_model = 'flat')
  or (vertical = 'law_firm'      and pricing_model in ('flat', 'retainer_plus_per_lead'))
  or (vertical = 'home_services')
);

comment on constraint sanaku_clients_pricing_legal on sanaku_clients is
  'Healthcare: flat fee only. Law firms: no revenue share (fee-splitting rules). Home services: unrestricted.';

-- ----------------------------------------------------------------------------
-- What a client owes for a period, computed from the lead meter rather than
-- from anything the client self-reports.
--
-- migration-013 replaces this with a wider return type, and Postgres will not
-- let CREATE OR REPLACE change a return type in place - it raises and aborts
-- the whole paste. So on any re-run of the bundles this file would kill
-- RUN-THIS-NOW.sql before it reached the CRM tables. Skipping when the
-- function already exists is the only option that is safe in every order:
-- dropping it first would silently drag a newer definition backwards.
-- ----------------------------------------------------------------------------
do $guard$
begin
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'sanaku_period_due'
  ) then
    raise notice 'sanaku_period_due already exists - leaving it to the later migration';
    return;
  end if;
  execute $fn$
create function sanaku_period_due(_client_id uuid, _from date, _to date)
returns table (
  leads_captured   int,
  qualified_leads  int,
  after_hours      int,
  retainer_due     numeric,
  per_lead_due     numeric,
  total_due        numeric
)
language sql stable as $$
  with c as (select * from sanaku_clients where id = _client_id),
  l as (
    select *
    from sanaku_client_leads
    where client_id = _client_id
      and billable = true
      and captured_at >= _from
      and captured_at < (_to + 1)
  )
  select
    (select count(*) from l)::int,
    (select count(*) from l where qualified)::int,
    (select count(*) from l where after_hours)::int,
    coalesce((select monthly_retainer from c), 0),
    least(
      coalesce((select per_lead_fee from c), 0) * (select count(*) from l where qualified),
      coalesce((select per_lead_monthly_cap from c), 1e9)
    ),
    coalesce((select monthly_retainer from c), 0) +
    least(
      coalesce((select per_lead_fee from c), 0) * (select count(*) from l where qualified),
      coalesce((select per_lead_monthly_cap from c), 1e9)
    )
$$;
  $fn$;
end $guard$;

-- Usage:  select * from sanaku_period_due('<client-uuid>', '2026-08-01', '2026-08-31');
