-- Manual override for the "Create a pool" fixture dropdown: the automatic
-- exclusion in fixtures_available_for_pool_creation only fires once every
-- pool referencing a fixture reaches a terminal status (SETTLED/CANCELLED/
-- VOIDED) — a fixture whose only pool is stuck OPEN/LOCKED/AWAITING_RESULT
-- forever (e.g. leftover/abandoned test data) never ages out that way. This
-- flag lets an admin hide such a fixture from the dropdown directly, while
-- leaving the fixture row itself intact in the "Imported fixtures" list as
-- a record.
alter table public.fixtures add column hidden_from_pool_creation boolean not null default false;

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
