-- FREE prediction mode — Phase 4 (analytics taxonomy, §11).
--
-- Every financial SUM in these functions already excludes FREE entries for
-- free, via standard SQL NULL semantics (entries.amount is null for FREE,
-- and SUM/coalesce skip nulls) — no change needed there. The exception is
-- any plain COUNT(*) over entries, which counts a row regardless of
-- whether its amount column is null: "Pools entered"/"Entries" on the
-- admin and user financial overviews, and the Top Users table's "Entries"
-- column, would otherwise silently count FREE predictions as if they were
-- real financial activity. Fixed here with a `filter (where amount is not
-- null)` on exactly those counts.
--
-- Deliberately NOT touched: wins/losses/graded_entries (accuracy) stay
-- combined across both modes — accuracy is an engagement metric, not a
-- financial one (§6, §11), and confirm_pool_grading_only marks FREE
-- entries WON/LOST through the identical grading path a PAID entry uses.
-- get_leaderboard and the streak columns on user_profiles are untouched
-- entirely — confirmed already money-agnostic by the architecture audit,
-- nothing in this migration touches them.

create or replace function public.get_platform_overview(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  pools_entered integer,
  entry_volume bigint,
  wins integer,
  losses integer,
  voids integer,
  graded_entries integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where e.amount is not null)::integer as pools_entered,
    coalesce(sum(case when e.status in ('WON', 'LOST') then e.amount else 0 end), 0)::bigint as entry_volume,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    count(*) filter (where e.status in ('VOID', 'REFUNDED'))::integer as voids,
    count(*) filter (where e.status in ('WON', 'LOST'))::integer as graded_entries
  from public.entries e
  where (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

create or replace function public.get_user_analytics_overview(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  pools_entered integer,
  entry_volume bigint,
  wins integer,
  losses integer,
  voids integer,
  graded_entries integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where e.amount is not null)::integer as pools_entered,
    coalesce(sum(case when e.status in ('WON', 'LOST') then e.amount else 0 end), 0)::bigint as entry_volume,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    count(*) filter (where e.status in ('VOID', 'REFUNDED'))::integer as voids,
    count(*) filter (where e.status in ('WON', 'LOST'))::integer as graded_entries
  from public.entries e
  where e.user_id = auth.uid()
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

create or replace function public.get_platform_top_users(
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_order text default 'net_result',
  p_limit integer default 20
)
returns table (
  user_id uuid,
  display_name text,
  username text,
  entries integer,
  entry_volume bigint,
  net_result bigint,
  wins integer,
  losses integer
)
language sql
stable
security definer
set search_path = public
as $$
  with graded as (
    select
      e.user_id,
      e.amount,
      e.status,
      (case when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount else -e.amount end)::bigint as net
    from public.entries e
    join public.pools p on p.id = e.pool_id
    join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
    left join public.wallet_transactions wt
      on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
    where e.status in ('WON', 'LOST')
      and s.created_at >= p_date_from
      and s.created_at < p_date_to
  ),
  per_user as (
    select
      user_id,
      count(*) filter (where amount is not null)::integer as entries,
      coalesce(sum(amount), 0)::bigint as entry_volume,
      coalesce(sum(net), 0)::bigint as net_result,
      count(*) filter (where status = 'WON')::integer as wins,
      count(*) filter (where status = 'LOST')::integer as losses
    from graded
    group by user_id
  )
  select
    pu.user_id,
    up.display_name,
    up.username,
    pu.entries,
    pu.entry_volume,
    pu.net_result,
    pu.wins,
    pu.losses
  from per_user pu
  join public.user_profiles up on up.id = pu.user_id
  order by
    (case when p_order = 'net_result' then pu.net_result else null end) desc nulls last,
    (case when p_order = 'entry_volume' then pu.entry_volume else null end) desc nulls last,
    (case when p_order = 'accuracy' then pu.wins::numeric / nullif(pu.wins + pu.losses, 0) else null end) desc nulls last,
    pu.net_result desc
  limit p_limit;
$$;

-- create or replace preserves existing grants, but restated explicitly per
-- the RPC-grant-drift precedent (SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md) —
-- unchanged from before this migration: the two platform-wide functions
-- stay service_role-only; the user-scoped one (auth.uid()-filtered) stays
-- also callable by authenticated.
revoke all on function public.get_platform_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_platform_overview(timestamptz, timestamptz) to service_role;

revoke all on function public.get_user_analytics_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_user_analytics_overview(timestamptz, timestamptz) to authenticated, service_role;

revoke all on function public.get_platform_top_users(timestamptz, timestamptz, text, integer) from public;
grant execute on function public.get_platform_top_users(timestamptz, timestamptz, text, integer) to service_role;
