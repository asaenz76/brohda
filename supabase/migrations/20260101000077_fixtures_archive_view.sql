-- Closes a gap in fixtures_available_for_pool_creation: a fixture that has
-- reached a terminal status (game finished, cancelled, abandoned, or
-- awarded) but never had any pool created against it was never excluded,
-- since the view only ever looked at the status of pools referencing the
-- fixture, not the fixture's own status. Terminal statuses here must match
-- TERMINAL_STATUSES in lib/sports-data/status-map.ts (the single TS source
-- of truth for "done, will never change again") — the same duplication
-- pattern already used for the pool-status literals below (see sync.ts's
-- own POOL_TERMINAL_STATUSES).
create or replace view public.fixtures_available_for_pool_creation as
select f.*
from public.fixtures f
where not f.hidden_from_pool_creation
  and f.internal_status not in ('COMPLETED', 'CANCELLED', 'ABANDONED', 'AWARDED')
  and (
    not exists (
      select 1 from public.pools p where p.fixture_id = f.id
    ) or exists (
      select 1 from public.pools p
      where p.fixture_id = f.id
        and p.status not in ('SETTLED', 'CANCELLED', 'VOIDED')
    )
  );
