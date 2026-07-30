-- Superseded by per-followed-item email preferences (team_follows.email_enabled
-- / league_follows.email_enabled) — this global "email me about every
-- published pool" toggle is exactly what 20260101000075's own disabling
-- comment said would eventually replace it. Must ship in the same deploy
-- as the code that stops referencing this column (profile form/action/
-- validation) or every profile save/load breaks until that code lands.
alter table public.user_profiles
  drop column email_notifications_enabled;
