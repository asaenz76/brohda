-- The league picker (pool creation) and the created pool's league header
-- both showed only the competition name ("1st Division"), ambiguous for
-- leagues that share a name/tier across countries. API-Football's fixture
-- payload already includes the country on `league.country` — it was just
-- never extracted into its own column (mapFixture only pulled id/name/logo/
-- season/round). Backfilled for free from provider_payload (the raw
-- fixture JSON is stored verbatim on every fixture ever synced/imported),
-- no re-fetch from the provider needed.
alter table public.fixtures add column competition_country text;

update public.fixtures
set competition_country = provider_payload -> 'league' ->> 'country'
where provider_payload is not null
  and provider_payload -> 'league' ->> 'country' is not null;

-- fixtures_available_for_pool_creation is `select f.*` — Postgres expands
-- that `*` into a fixed column list at CREATE VIEW time, not on every
-- query, so adding a column to `fixtures` doesn't reach the view until it's
-- explicitly re-created. Without this, any caller selecting the new column
-- through the view (the pool-creation fixture picker) gets a bare
-- "column ... does not exist" error. Same body as
-- 20260101000029_fixtures_hidden_flag.sql, just re-run to pick up the new
-- column.
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
