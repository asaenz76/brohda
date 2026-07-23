-- Second review pass: date-attribution model + financial source of truth.
--
-- 1. Date attribution was entirely entry-dated (entries.created_at) for
--    EVERY metric, including realized P&L — meaning a pool entered June
--    30 and settled July 3 silently changed June's "Net result" after
--    June had already closed. Split into three concerns:
--    - Activity (get_user_analytics_overview): pools_entered, entry_volume,
--      wins/losses/voids/graded_entries — entry-dated. Still answers "what
--      did I do this period" and "how did entries placed this period turn
--      out" (the latter is a *cohort* result — the UI must label it as
--      such, since it can still change until every entry in the cohort
--      settles). No longer returns net_result.
--    - Financial (new get_user_financial_overview): net_result and the
--      inputs for realized ROI — attributed by realization date, i.e.
--      settlements.created_at (the pool's CURRENT settlement — same
--      grading_version = snapshot_version scoping as everywhere else),
--      which is the one always-populated timestamp shared atomically by
--      the WON payout (written in the same DB transaction) and the LOST
--      entry's resolution alike. VOID/REFUNDED contributes to net_result
--      too, dated by its own wallet_transactions.pool_refund_credit.created_at.
--    - Category/competition breakdowns stay entry-dated (cohort
--      performance) — that's an explicit, disclosed scope boundary, not
--      an oversight: re-attributing per-category P&L by realization date
--      is a larger rewrite than this pass covers, so the UI must label
--      these breakdowns as cohort results too.
--
-- 2. Realized ROI = graded_net_result / stake_basis, BOTH scoped to the
--    same realization-dated, WON/LOST-only rows. VOID/REFUND is excluded
--    from both sides (consistent with how "accuracy" already excludes
--    them) — a full refund's 0-net-result would otherwise silently drag
--    ROI toward zero for money that was never actually at risk once
--    returned. A reversed-then-resettled entry is counted exactly once,
--    dated by the CURRENT settlement only (same scoping already used
--    throughout 20260101000067).
--
-- 3. Financial source of truth: wallet_transactions.pool_payout_credit
--    (not settlement_payouts) is now the payout amount source everywhere.
--    Verified atomic-and-consistent with settlement_payouts at write time
--    (both inserted in the same DB transaction, same amount, in the one
--    settle-pool function) — but wallet_transactions alone also covers
--    refunds/reversals in the exact same table/shape, so using it
--    everywhere removes the need for a second, differently-shaped join
--    (settlement_payouts + a separate refund lateral) that
--    20260101000067 still needed. settlement_payouts itself is untouched
--    — still the correct source for the admin settlement-history view,
--    whose (settlement_id, entry_id) uniqueness constraint is a useful
--    integrity guard there.
--
-- 4. get_user_category_performance now groups by pools.analytics_category
--    (the immutable creation-time snapshot from 20260101000069) instead
--    of live pool_type/template_id — a later template-registry change
--    can no longer alter historical category totals.
--
-- 5. get_user_monthly_activity / get_user_cumulative_pnl gain a
--    p_timezone parameter — date_trunc on a bare timestamptz buckets in
--    whatever zone the DB session happens to be in, not the user's
--    chosen zone. The `date_trunc(gran, ts at time zone p_tz) at time
--    zone p_tz` idiom converts to the user's local wall-clock, truncates
--    there, then converts back to an absolute instant. get_user_cumulative_pnl
--    additionally switches from entry-dated to realization-dated
--    bucketing (settlements.created_at) — it's explicitly a P&L chart,
--    the same class of bug as the overview card.

drop function if exists public.get_user_analytics_overview(timestamptz, timestamptz);

create function public.get_user_analytics_overview(
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
  where e.user_id = auth.uid()
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

revoke all on function public.get_user_analytics_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_user_analytics_overview(timestamptz, timestamptz) to authenticated, service_role;

create function public.get_user_financial_overview(
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
      (case when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount else -e.amount end)::bigint as net,
      s.created_at as realized_at
    from public.entries e
    join public.pools p on p.id = e.pool_id
    join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
    left join public.wallet_transactions wt
      on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
    where e.user_id = auth.uid()
      and e.status in ('WON', 'LOST')
      and s.created_at >= p_date_from
      and s.created_at < p_date_to
  ),
  refunds as (
    select (wt.amount - e.amount)::bigint as net
    from public.entries e
    join public.wallet_transactions wt on wt.entry_id = e.id and wt.type = 'pool_refund_credit'
    where e.user_id = auth.uid()
      and e.status in ('VOID', 'REFUNDED')
      and wt.created_at >= p_date_from
      and wt.created_at < p_date_to
  )
  select
    (coalesce((select sum(net) from graded), 0) + coalesce((select sum(net) from refunds), 0))::bigint as net_result,
    coalesce((select sum(net) from graded), 0)::bigint as graded_net_result,
    coalesce((select sum(amount) from graded), 0)::bigint as stake_basis;
$$;

revoke all on function public.get_user_financial_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_user_financial_overview(timestamptz, timestamptz) to authenticated, service_role;

drop function if exists public.get_user_category_performance(timestamptz, timestamptz);

create function public.get_user_category_performance(
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
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by p.analytics_category;
$$;

revoke all on function public.get_user_category_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_user_category_performance(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.get_user_competition_performance(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  competition_key text,
  competition_name text,
  entries integer,
  entry_volume bigint,
  net_result bigint,
  wins integer,
  losses integer,
  avg_payout numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(f.competition_external_id, 'name:' || f.competition_name) as competition_key,
    (array_agg(f.competition_name order by e.created_at desc))[1] as competition_name,
    count(*)::integer as entries,
    coalesce(sum(e.amount), 0)::bigint as entry_volume,
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount
        else -e.amount
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    round(avg(wt.amount) filter (where e.status = 'WON'), 2) as avg_payout
  from public.entries e
  join public.pools p on p.id = e.pool_id
  join public.fixtures f on f.id = p.fixture_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.wallet_transactions wt
    on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and f.competition_name is not null
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by coalesce(f.competition_external_id, 'name:' || f.competition_name);
$$;

drop function if exists public.get_user_monthly_activity(timestamptz, timestamptz, text);

create function public.get_user_monthly_activity(
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
  where e.user_id = auth.uid()
    and e.created_at >= p_date_from
    and e.created_at < p_date_to
  group by 1
  order by 1;
$$;

revoke all on function public.get_user_monthly_activity(timestamptz, timestamptz, text, text) from public;
grant execute on function public.get_user_monthly_activity(timestamptz, timestamptz, text, text) to authenticated, service_role;

drop function if exists public.get_user_cumulative_pnl(timestamptz, timestamptz, text);

create function public.get_user_cumulative_pnl(
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_granularity text default 'month',
  p_timezone text default 'UTC'
)
returns table (bucket timestamptz, bucket_net_result bigint, cumulative_net_result bigint)
language sql
security definer
set search_path = public
stable
as $$
  with graded as (
    select
      (date_trunc(
        case when p_granularity in ('day', 'week', 'month') then p_granularity else 'month' end,
        s.created_at at time zone p_timezone
      ) at time zone p_timezone) as bucket,
      (case
        when e.status = 'WON' then coalesce(wt.amount, 0) - e.amount
        else -e.amount
      end)::bigint as net_result
    from public.entries e
    join public.pools p on p.id = e.pool_id
    join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
    left join public.wallet_transactions wt
      on wt.entry_id = e.id and wt.type = 'pool_payout_credit' and wt.settlement_id = s.id
    where e.user_id = auth.uid()
      and e.status in ('WON', 'LOST')
      and s.created_at >= p_date_from
      and s.created_at < p_date_to
  ),
  bucketed as (
    select bucket, sum(net_result)::bigint as bucket_net_result
    from graded
    group by bucket
  )
  select
    bucket,
    bucket_net_result,
    sum(bucket_net_result) over (order by bucket)::bigint as cumulative_net_result
  from bucketed
  order by bucket;
$$;

revoke all on function public.get_user_cumulative_pnl(timestamptz, timestamptz, text, text) from public;
grant execute on function public.get_user_cumulative_pnl(timestamptz, timestamptz, text, text) to authenticated, service_role;
