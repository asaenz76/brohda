-- Lets super admins see which teams/leagues a user follows on the new
-- admin user detail page. Same shape as wallet_balances' admin-visibility
-- policy (20260101000007) — a second permissive select policy alongside
-- the existing own-row one (select_own_team_follows/select_own_league_follows),
-- combined by Postgres RLS with OR. super_admin only (not is_admin_or_above)
-- since this is another user's private preference data, matching the
-- money-visibility precedent rather than the broader admin-roster policies.
create policy "select_all_team_follows_as_admin"
on public.team_follows for select
to authenticated
using (public.is_super_admin(auth.uid()));

create policy "select_all_league_follows_as_admin"
on public.league_follows for select
to authenticated
using (public.is_super_admin(auth.uid()));
