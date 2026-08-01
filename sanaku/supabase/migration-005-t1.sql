-- ============================================================================
-- Migration 005 - T1 Missed-Call Text-Back
-- Run after migration-004-security.sql.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Per-client operating parameters for the deployed workflow.
-- business_hours drives the after_hours flag - the number that renews
-- contracts ("37 of the 84 leads we caught came in while you were closed").
-- ----------------------------------------------------------------------------
alter table sanaku_clients
  add column if not exists timezone          text not null default 'America/Los_Angeles',
  add column if not exists business_hours    jsonb not null default
    '{"mon":["08:00","17:00"],"tue":["08:00","17:00"],"wed":["08:00","17:00"],"thu":["08:00","17:00"],"fri":["08:00","17:00"],"sat":null,"sun":null}'::jsonb,
  add column if not exists textback_message  text,
  add column if not exists escalation_phone  text,
  add column if not exists escalation_email  text,
  add column if not exists inbound_number    text;   -- the number customers dial

create index if not exists sanaku_clients_inbound_idx on sanaku_clients (inbound_number);

comment on column sanaku_clients.textback_message is
  'First text sent after a missed call. {brand} is substituted. Falls back to a default if null.';

-- ----------------------------------------------------------------------------
-- Per-client opt-out list. A STOP from a customer must be permanent and must
-- never bleed across clients.
-- ----------------------------------------------------------------------------
create table if not exists sanaku_client_suppression (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references sanaku_clients (id) on delete cascade,
  phone      text not null,
  reason     text,
  created_at timestamptz not null default now(),
  unique (client_id, phone)
);

alter table sanaku_client_suppression enable row level security;
alter table sanaku_client_suppression force  row level security;
drop policy if exists staff_all on sanaku_client_suppression;
create policy staff_all on sanaku_client_suppression for all to authenticated
  using ((select public.sanaku_is_staff())) with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- Lead lifecycle fields for the text conversation.
-- ----------------------------------------------------------------------------
alter table sanaku_client_leads
  add column if not exists conversation   jsonb not null default '[]'::jsonb,
  add column if not exists last_message_at timestamptz,
  add column if not exists provider_sid   text;

create index if not exists sanaku_client_leads_phone_idx on sanaku_client_leads (client_id, phone);

-- ----------------------------------------------------------------------------
-- Is a given moment inside this client's business hours?
-- Used to set after_hours at capture time.
-- ----------------------------------------------------------------------------
create or replace function public.sanaku_is_after_hours(_client_id uuid, _at timestamptz default now())
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  _tz    text;
  _hours jsonb;
  _local timestamptz;
  _dow   text;
  _span  jsonb;
  _t     time;
begin
  select c.timezone, c.business_hours into _tz, _hours
  from public.sanaku_clients c where c.id = _client_id;
  if _tz is null then return true; end if;              -- unknown client: treat as after hours

  _local := _at at time zone _tz;
  _dow   := lower(to_char(_at at time zone _tz, 'dy'));
  _span  := _hours -> _dow;
  if _span is null or jsonb_typeof(_span) = 'null' then
    return true;                                        -- closed that day
  end if;
  _t := (_at at time zone _tz)::time;
  return not (_t >= (_span ->> 0)::time and _t < (_span ->> 1)::time);
end $$;

revoke execute on function public.sanaku_is_after_hours(uuid, timestamptz) from public, anon;
grant   execute on function public.sanaku_is_after_hours(uuid, timestamptz) to authenticated;

commit;
