-- Powers stage-gating on the "Create a pool" template picker: a Cup
-- fixture is single-elimination (no draw is ever the final outcome, so
-- only "Who will advance?" makes sense), while a League fixture's regular
-- match can end in a draw ("Result after regulation" is the valid one).
--
-- Unlike competition_country (20260101000048), this can't be backfilled
-- from provider_payload — API-Football's /fixtures endpoint never
-- returned league.type in the first place (confirmed against
-- ApiFootballFixtureResponse in lib/sports-data/api-football-provider.ts,
-- which only ever mapped id/name/country/logo/season/round from that
-- payload). It's only available from the separate /leagues endpoint, so
-- this column stays null for every fixture already imported until the app
-- layer starts populating it going forward (lib/actions/fixtures.ts's
-- importOneFixture, via the new getLeagueType() provider call).
alter table public.fixtures add column competition_type text;

-- fixtures_available_for_pool_creation is `select f.*` — Postgres expands
-- that `*` into a fixed column list at CREATE VIEW time, not on every
-- query, so adding a column to `fixtures` doesn't reach the view until
-- it's explicitly re-created. Same body as
-- 20260101000048_fixture_competition_country.sql, just re-run to pick up
-- the new column.
create or replace view public.fixtures_available_for_pool_creation as
select f.*
from public.fixtures f
where not f.hidden_from_pool_creation
  and (
    not exists (
      select 1 from public.pools p where p.fixture_id = f.id
    ) or exists (
      select 1 from public.pools p
      where p.fixture_id = f.id
        and p.status not in ('SETTLED', 'CANCELLED', 'VOIDED')
    )
  );

grant select on public.fixtures_available_for_pool_creation to authenticated, service_role;
