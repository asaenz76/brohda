-- A fixture with every one of its pools already graded (SETTLED, CANCELLED,
-- or VOIDED) has nothing left to attach a new pool to and only clutters the
-- "Create a pool" fixture dropdown from here on — exclude it there. A
-- fixture with no pools yet (freshly imported) or with at least one pool
-- still in flight (DRAFT/OPEN/LOCKED/AWAITING_RESULT/READY_FOR_REVIEW/
-- REVERSAL_FAILED_MANUAL_REVIEW) stays available, since multiple pools of
-- different pool_types can share one real-world fixture.
create view public.fixtures_available_for_pool_creation as
select f.*
from public.fixtures f
where not exists (
  select 1 from public.pools p where p.fixture_id = f.id
) or exists (
  select 1 from public.pools p
  where p.fixture_id = f.id
    and p.status not in ('SETTLED', 'CANCELLED', 'VOIDED')
);

grant select on public.fixtures_available_for_pool_creation to authenticated, service_role;
