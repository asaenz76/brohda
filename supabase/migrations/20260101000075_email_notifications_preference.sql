-- Opt-out toggle for the new "a pool was published" email notification
-- (lib/email/notify-pool-published.ts). Defaults to true — an explicit
-- opt-out, not an opt-in, since this is a private group of people who
-- already chose to join, not a public mailing list.
alter table public.user_profiles
  add column email_notifications_enabled boolean not null default true;

-- user_profiles has a blanket `revoke update ... from authenticated`
-- (20260101000002) with per-column grants added back explicitly
-- (20260101000038) — this column needs the same treatment or every
-- player's own toggle update silently fails.
grant update (email_notifications_enabled) on public.user_profiles to authenticated;
