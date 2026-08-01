-- ============================================================================
-- Add a Sanaku operator login
--
-- Run this AFTER creating the account in
--   Supabase -> Authentication -> Users -> Add user.
--
-- Staff see everything: every prospect, every client, every note. Only add
-- accounts that are yours. Client contacts get a portal login instead, via
-- the Invite button in the client roster - never this.
--
-- To use a different address, change the one line marked below.
--
-- Supabase -> SQL Editor -> New query -> paste -> Run.
-- Safe to run more than once.
-- ============================================================================

do $$
declare
  want text := 'sanakuuai@gmail.com';   -- <<< the operator address
  uid  uuid;
begin
  select id into uid from auth.users where lower(email) = lower(want);

  -- Refuse if the account doesn't exist yet, rather than silently doing
  -- nothing and leaving you to wonder why the login fails.
  if uid is null then
    raise exception
      'No auth account for %. Create it first: Authentication -> Users -> Add user (tick "Auto Confirm User"), then re-run this.', want;
  end if;

  -- A portal user must never be promoted to staff: they would gain read
  -- access to every other client's leads.
  if exists (select 1 from sanaku_client_users where user_id = uid) then
    raise exception
      '% is a CLIENT portal user. Promoting it to staff would expose every client''s data to them. Aborting.', want;
  end if;

  insert into sanaku_staff (user_id) values (uid) on conflict do nothing;
  raise notice 'Staff access granted to %', want;
end $$;


-- Confirm. Every operator login, and nothing that should not be here.
select u.email,
       u.last_sign_in_at,
       (s.user_id is not null) as is_staff
from auth.users u
left join sanaku_staff s on s.user_id = u.id
order by is_staff desc, u.created_at;
