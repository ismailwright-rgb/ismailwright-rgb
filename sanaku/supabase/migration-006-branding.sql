-- ============================================================================
-- Migration 006 - client logo storage
-- Run after migration-004-security.sql.
--
-- Logos live in a PUBLIC bucket: a client's portal renders the image in their
-- browser, and portal users have no storage credentials. Public read is fine -
-- a logo is a public asset by nature - but only staff may write.
-- ============================================================================

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-logos', 'client-logos', true, 2097152,
        array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

-- Anyone may read (the client's browser fetches it unauthenticated);
-- only staff may add, replace or remove.
drop policy if exists "client logos are publicly readable" on storage.objects;
create policy "client logos are publicly readable" on storage.objects
  for select using (bucket_id = 'client-logos');

drop policy if exists "staff manage client logos" on storage.objects;
create policy "staff manage client logos" on storage.objects
  for all to authenticated
  using (bucket_id = 'client-logos' and (select public.sanaku_is_staff()))
  with check (bucket_id = 'client-logos' and (select public.sanaku_is_staff()));

commit;
