-- Phase 2 of the pool-template registry: cached raw /fixtures/events
-- payload, fetched lazily by lib/sports-data/sync.ts only for fixtures
-- with an active event-dependent TEMPLATE_GRADED pool. Nullable — null
-- means "not fetched yet" (or not needed), never "no events occurred";
-- lib/pools/templates/grade.ts treats null as PENDING, never as an empty
-- events array.
alter table public.fixtures
  add column provider_events_payload jsonb,
  add column events_synced_at timestamptz;

-- Re-run so the view (select f.*) picks up the two new columns —
-- same gotcha as every prior fixtures column addition (000029/000048/000049).
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
