-- Profile expansion: pronouns, gender, short bio — each individually
-- hideable from the public profile (opt-out, default visible). username
-- isn't given a show_* flag: it's already the routing key for
-- /profile/[username], so hiding it from the profile itself wouldn't hide
-- anything meaningful.
alter table public.user_profiles
  add column pronouns text,
  add column gender text,
  add column bio text,
  add column show_pronouns boolean not null default true,
  add column show_gender boolean not null default true,
  add column show_bio boolean not null default true;

alter table public.user_profiles
  add constraint user_profiles_pronouns_length check (char_length(pronouns) <= 30),
  add constraint user_profiles_gender_length check (char_length(gender) <= 30),
  add constraint user_profiles_bio_length check (char_length(bio) <= 160);

-- Same column-level allow-list pattern as the existing display_name/
-- username/avatar_url grant below (not shown here — set once in
-- 20260101000002) — extend it rather than granting blanket UPDATE.
grant update (pronouns, gender, bio, show_pronouns, show_gender, show_bio)
  on public.user_profiles to authenticated;

-- pronouns/gender/bio null out per-field when the owner has hidden them —
-- same nulling-in-the-view technique pool_options_public uses for
-- participation_visibility. CREATE OR REPLACE VIEW only allows appending
-- columns, not reordering, so these land after username (20260101000015).
create or replace view public.public_profiles
with (security_invoker = false) as
select
  id,
  display_name,
  avatar_url,
  username,
  case when show_pronouns then pronouns else null end as pronouns,
  case when show_gender then gender else null end as gender,
  case when show_bio then bio else null end as bio
from public.user_profiles
where is_active = true;
