-- ============================================================================
-- Migration 026 - move the send switch out of the environment
--
-- W2s gated sending on $env.SANAKU_SEND_ENABLED. That works, but it can only be
-- changed by someone with shell access to the droplet who then restarts n8n -
-- which means the person who owns the decision cannot make it, and the one
-- control that stops every outbound email lives furthest from the person
-- responsible for it.
--
-- It lives here now. Flipping it is a row update, so the dashboard can own it
-- and show its state honestly beside the drafts it governs.
--
-- sanaku_settings.value is numeric, so the switch is 1 or 0 rather than a
-- boolean. Anything other than exactly 1 is off - same fail-safe rule the env
-- var had, for the same reason: a wrong value must not start a campaign.
--
-- Safe to run more than once. Deliberately does NOT overwrite an existing
-- value: re-running a migration must never silently re-enable sending.
-- ============================================================================

insert into public.sanaku_settings (key, value, note)
values (
  'send_enabled', 0,
  'Master switch for outbound cold email. 1 = W2s may send on its schedule; '
  || 'anything else = it stops before composing. The Approve & send button in '
  || 'the dashboard bypasses this deliberately - a human clicking it IS the '
  || 'authorisation, and this switch governs the UNATTENDED sender.'
)
on conflict (key) do nothing;

-- Read it as a boolean, so callers cannot get the 1-means-on rule wrong.
create or replace function public.sanaku_send_enabled()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((select value = 1 from public.sanaku_settings where key = 'send_enabled'), false);
$$;

revoke execute on function public.sanaku_send_enabled() from public, anon;
grant execute on function public.sanaku_send_enabled() to authenticated, service_role;

-- The dashboard needs to read and flip it; staff only, like everything else.
alter table public.sanaku_settings enable row level security;
revoke all on public.sanaku_settings from anon;
drop policy if exists sanaku_settings_staff_all on public.sanaku_settings;
create policy sanaku_settings_staff_all on public.sanaku_settings
  for all to authenticated
  using ((select public.sanaku_is_staff()))
  with check ((select public.sanaku_is_staff()));

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
--   select public.sanaku_send_enabled();          -- false until deliberately set
--   update sanaku_settings set value = 1 where key = 'send_enabled';
--   select public.sanaku_send_enabled();          -- true
--
--   -- and today's remaining allowance, which is a separate brake:
--   select day, cap, sent, cap - sent as left from sanaku_send_budget;
