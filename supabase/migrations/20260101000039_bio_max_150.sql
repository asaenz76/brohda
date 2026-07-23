-- Tighten the bio cap from 160 to 150 chars (product decision, matches the
-- UI's character countdown). Truncate any pre-existing over-limit value
-- first so the stricter constraint can't fail to attach.
update public.user_profiles set bio = left(bio, 150) where char_length(bio) > 150;

alter table public.user_profiles drop constraint user_profiles_bio_length;
alter table public.user_profiles
  add constraint user_profiles_bio_length check (char_length(bio) <= 150);
