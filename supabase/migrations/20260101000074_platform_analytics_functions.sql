-- Platform-wide (all-users) analytics for the new /admin/analytics page.
-- Mirrors the definitions in 20260101000071_analytics_financial_rewrite.sql
-- exactly (same date-attribution rules: activity is entry-dated, financial
-- is realization-dated via settlements.created_at) minus the
-- `e.user_id = auth.uid()` filter — these are the platform-wide siblings
-- of get_user_analytics_overview/get_user_financial_overview/
-- get_user_category_performance/get_user_monthly_activity.
--
-- Unlike the get_user_* functions (granted to `authenticated`, safe
-- because they're self-scoped via auth.uid()), these expose every user's
-- financial data and are granted to `service_role` ONLY — enforcement is
-- "only the admin client can call it" (matches pool_options/
-- delete_terminal_pool's lockdown pattern), never an internal role check.
-- lib/analytics/adminAnalyticsService.ts calls these via createAdminClient()
-- from a page already gated by requireSuperAdmin().

create function public.get_platform_overview(
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
security definer
set search_path = public
stable
as $$
  select
    count(*)::integer as pools_entered,
    coalesce(sum(case when e.status in ('WON', 'LOST') then e.amount else 0 end), 0)::bigint as entry_volume,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    count(*) filter (where e.status in ('VOID', 'REFUNDED'))::integer as voids,
    count(*) filter (where e.status in ('WON', 'LOST'))::integer as graded_entries
  from public.entries e
  where (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

revoke all on function public.get_platform_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_platform_overview(timestamptz, timestamptz) to service_role;

create function public.get_platform_financial_overview(
  p_date_from timestamptz,
  p_date_to timestamptz
)
returns table (
  net_result bigint,
  graded_net_result bigint,
  stake_basis bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with graded as (
    select
      e.amount,
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
  refunds as (
    select (wt.amount - e.amount)::bigint as net
    from public.entries e
    join public.wallet_transactions wt on wt.entry_id = e.id and wt.type = 'pool_refund_credit'
    where e.status in ('VOID', 'REFUNDED')
      and wt.created_at >= p_date_from
      and wt.created_at < p_date_to
  )
  select
    (coalesce((select sum(net) from graded), 0) + coalesce((select sum(net) from refunds), 0))::bigint as net_result,
    coalesce((select sum(net) from graded), 0)::bigint as graded_net_result,
    coalesce((select sum(amount) from graded), 0)::bigint as stake_basis;
$$;

revoke all on function public.get_platform_financial_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_platform_financial_overview(timestamptz, timestamptz) to service_role;

create function public.get_platform_category_performance(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  category public.analytics_category,
  entries integer,
  entry_volume bigint,
  net_result bigint,
  wins integer,
  losses integer
)
language sql
security definer
set search_path = public
stable
as $$
  select
    p.analytics_category as category,
    count(*)::integer as entries,
    coalesce(sum(e.amount), 0)::bigint as entry_volume,
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount
        else -e.amount
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.wallet_transactions wt
    on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
  where e.status in ('WON', 'LOST')
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by p.analytics_category;
$$;

revoke all on function public.get_platform_category_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_platform_category_performance(timestamptz, timestamptz) to service_role;

create function public.get_platform_monthly_activity(
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_granularity text default 'month',
  p_timezone text default 'UTC'
)
returns table (
  bucket timestamptz,
  pools_entered integer,
  entry_volume bigint,
  payouts bigint,
  net_result bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    (date_trunc(
      case when p_granularity in ('day', 'week', 'month') then p_granularity else 'month' end,
      e.created_at at time zone p_timezone
    ) at time zone p_timezone) as bucket,
    count(*)::integer as pools_entered,
    coalesce(sum(case when e.status in ('WON', 'LOST') then e.amount else 0 end), 0)::bigint as entry_volume,
    coalesce(sum(case when e.status = 'WON' then coalesce(wt.amount, 0) else 0 end), 0)::bigint as payouts,
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount
        when e.status = 'LOST' then -e.amount
        when e.status in ('VOID', 'REFUNDED') then coalesce(refund.refund_amount, 0) - e.amount
        else 0
      end
    ), 0)::bigint as net_result
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.wallet_transactions wt
    on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
  left join lateral (
    select coalesce(sum(rwt.amount), 0) as refund_amount
    from public.wallet_transactions rwt
    where rwt.entry_id = e.id and rwt.type = 'pool_refund_credit'
  ) refund on true
  where e.created_at >= p_date_from
    and e.created_at < p_date_to
  group by 1
  order by 1;
$$;

revoke all on function public.get_platform_monthly_activity(timestamptz, timestamptz, text, text) from public;
grant execute on function public.get_platform_monthly_activity(timestamptz, timestamptz, text, text) to service_role;

-- No per-user equivalent needed — a user never needs to rank themselves
-- against others. Built the same way get_platform_category_performance
-- is (join entries -> pools -> settlements, realization-dated), grouped
-- by e.user_id and joined to user_profiles for display fields.
create function public.get_platform_top_users(
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
security definer
set search_path = public
stable
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
      count(*)::integer as entries,
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

revoke all on function public.get_platform_top_users(timestamptz, timestamptz, text, integer) from public;
grant execute on function public.get_platform_top_users(timestamptz, timestamptz, text, integer) to service_role;
