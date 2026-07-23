-- Pool cards show the league's crest instead of the (always-admin) pool
-- creator's name/avatar — needs a place to persist it. home_team_logo_url/
-- away_team_logo_url already exist; this is the competition-level
-- equivalent, sourced from api-football's fixtures response `league.logo`.
alter table public.fixtures
  add column competition_logo_url text;
