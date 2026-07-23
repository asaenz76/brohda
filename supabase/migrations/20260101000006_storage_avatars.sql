-- Phase 1: avatar storage bucket (spec X.8, §19)

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Public read (bucket is public); writes happen exclusively through the
-- server-side avatar upload route using the service role (which bypasses
-- RLS), never directly from the browser.
create policy "avatars_public_read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'avatars');
