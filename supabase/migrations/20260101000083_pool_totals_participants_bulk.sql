-- Bulk counterparts to get_pool_totals/get_pool_participants (both kept in
-- place — still used by getPoolLiveStats's realtime per-card refetch and
-- by lib/landing/fetch.ts's marketing-page preview). Collapses
-- getPoolCardViewModels's per-pool RPC fan-out (2 round trips × N pools,
-- for every Feed/Predictions-tab load) into 2 round trips total.
--
-- get_pool_totals_bulk always returns a row per pool (pool_options rows
-- exist from the moment a pool is created, entry_count/total_entry_amount
-- simply start at 0 — coalesce only ever matters for a genuinely-missing
-- pool_options row, which shouldn't happen in practice). get_pool_
-- participants_bulk is different: it's keyed off `entries`, which has
-- *zero* rows for a pool nobody has entered — that pool is entirely
-- absent from the result, not a zero-row. Callers must treat a missing
-- pool_id in the participants map as the empty-array fallback.
create or replace function public.get_pool_totals_bulk(p_pool_ids uuid[])
returns table (pool_id uuid, total_entries integer, gross_pool bigint)
language sql
security definer
set search_path = public
stable
as $$
  select
    po.pool_id,
    coalesce(sum(po.entry_count), 0)::integer,
    coalesce(sum(po.total_entry_amount), 0)::bigint
  from public.pool_options po
  where po.pool_id = any(p_pool_ids)
  group by po.pool_id;
$$;

revoke all on function public.get_pool_totals_bulk(uuid[]) from public;
grant execute on function public.get_pool_totals_bulk(uuid[]) to authenticated, service_role;

create or replace function public.get_pool_participants_bulk(p_pool_ids uuid[])
returns table (pool_id uuid, user_id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select e.pool_id, up.id, up.display_name, up.avatar_url
  from public.entries e
  join public.user_profiles up on up.id = e.user_id
  where e.pool_id = any(p_pool_ids) and e.status in ('ACTIVE', 'WON', 'LOST')
  order by e.pool_id, e.created_at asc;
$$;

revoke all on function public.get_pool_participants_bulk(uuid[]) from public;
grant execute on function public.get_pool_participants_bulk(uuid[]) to authenticated, service_role;
