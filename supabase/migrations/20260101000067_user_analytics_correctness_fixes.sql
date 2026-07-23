-- Correctness fixes surfaced by an independent review of the Phase 1/2
-- user analytics functions (20260101000064/65):
--
-- 1. settlement_payouts is unique on (settlement_id, entry_id), NOT on
--    entry_id alone — an entry that was settled, reversed (which resets
--    entries.status to ACTIVE and creates a NEW settlements row via
--    reverse_pool_settlement, without deleting the old settlement_payouts
--    row), and re-settled ends up with TWO settlement_payouts rows for
--    the same entry_id. Every join below that was `sp.entry_id = e.id`
--    unscoped would silently double-count that entry in every SUM. Fixed
--    by scoping through the pool's CURRENT settlement
--    (settlements.grading_version = pools.snapshot_version) — the same
--    "current settlement" pattern already used in
--    tests/integration/template-pools.test.ts.
-- 2. VOID/REFUNDED entries were assumed to always net to exactly 0. True
--    for a full refund, but wrong for NO_WINNING_ENTRIES_FEE_RETAINED
--    (combo-specific, platform keeps a fee) — now pulls the actual
--    credited amount from wallet_transactions (pool_refund_credit).
-- 3. get_user_competition_performance grouped by fixtures.competition_name
--    — a display string, not a stable identifier, so two different
--    competitions sharing a name (plausible across countries/divisions)
--    would silently merge. Now groups by competition_external_id
--    (falling back to a clearly-marked name-based key only when the
--    external id was never populated), with the most recent name shown
--    for display.
-- 4. Every ORDER BY created_at now has an explicit id tiebreaker.
--    Postgres's now() is transaction-stable — two entries/transactions
--    written in the same transaction share the exact same created_at, so
--    ties are routine, not a rare edge case, and without a secondary key
--    the sort order (and therefore any running-sum sequence) is
--    nondeterministic.

create or replace function public.get_user_analytics_overview(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  pools_entered integer,
  entry_volume bigint,
  net_result bigint,
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
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
        when e.status = 'LOST' then -e.amount
        when e.status in ('VOID', 'REFUNDED') then coalesce(refund.refund_amount, 0) - e.amount
        else 0
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    count(*) filter (where e.status in ('VOID', 'REFUNDED'))::integer as voids,
    count(*) filter (where e.status in ('WON', 'LOST'))::integer as graded_entries
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
  left join lateral (
    select coalesce(sum(wt.amount), 0) as refund_amount
    from public.wallet_transactions wt
    where wt.entry_id = e.id and wt.type = 'pool_refund_credit'
  ) refund on true
  where e.user_id = auth.uid()
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

create or replace function public.get_user_category_performance(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  pool_type text,
  template_id text,
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
    p.pool_type::text,
    p.template_id,
    count(*)::integer as entries,
    coalesce(sum(e.amount), 0)::bigint as entry_volume,
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
        else -e.amount
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by p.pool_type, p.template_id;
$$;

-- Groups by the provider's stable competition id, not the display name —
-- see header comment. competition_name shown for display is the most
-- recent one seen for that id (in case of a rebrand), via array_agg
-- ordered by entry recency.
--
-- Adds a new output column (competition_key) — CREATE OR REPLACE cannot
-- change a function's RETURNS TABLE shape, so the old definition must be
-- dropped explicitly first.
drop function if exists public.get_user_competition_performance(timestamptz, timestamptz);

create function public.get_user_competition_performance(
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
        when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
        else -e.amount
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    round(avg(sp.amount) filter (where e.status = 'WON'), 2) as avg_payout
  from public.entries e
  join public.pools p on p.id = e.pool_id
  join public.fixtures f on f.id = p.fixture_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and f.competition_name is not null
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by coalesce(f.competition_external_id, 'name:' || f.competition_name);
$$;

-- Explicit drop above means grants are NOT inherited (unlike CREATE OR
-- REPLACE) — must be re-established here.
revoke all on function public.get_user_competition_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_user_competition_performance(timestamptz, timestamptz) to authenticated, service_role;

create or replace function public.get_user_monthly_activity(
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_granularity text default 'month'
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
    date_trunc(
      case when p_granularity in ('day', 'week', 'month') then p_granularity else 'month' end,
      e.created_at
    ) as bucket,
    count(*)::integer as pools_entered,
    coalesce(sum(case when e.status in ('WON', 'LOST') then e.amount else 0 end), 0)::bigint as entry_volume,
    coalesce(sum(case when e.status = 'WON' then coalesce(sp.amount, 0) else 0 end), 0)::bigint as payouts,
    coalesce(sum(
      case
        when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
        when e.status = 'LOST' then -e.amount
        when e.status in ('VOID', 'REFUNDED') then coalesce(refund.refund_amount, 0) - e.amount
        else 0
      end
    ), 0)::bigint as net_result
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
  left join lateral (
    select coalesce(sum(wt.amount), 0) as refund_amount
    from public.wallet_transactions wt
    where wt.entry_id = e.id and wt.type = 'pool_refund_credit'
  ) refund on true
  where e.user_id = auth.uid()
    and e.created_at >= p_date_from
    and e.created_at < p_date_to
  group by 1
  order by 1;
$$;

create or replace function public.get_user_entry_history(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_order text default 'recent',
  p_limit integer default 20
)
returns table (
  entry_id uuid,
  pool_id uuid,
  question text,
  fixture_label text,
  competition_name text,
  option_label text,
  amount bigint,
  payout bigint,
  net_result bigint,
  final_option_share numeric,
  status text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  with pool_totals as (
    select pool_id, sum(total_entry_amount) as total_pot
    from public.pool_options
    group by pool_id
  )
  select
    e.id as entry_id,
    e.pool_id,
    coalesce(p.title, p.question) as question,
    case when f.id is not null then f.home_team_name || ' vs ' || f.away_team_name else null end as fixture_label,
    f.competition_name,
    po.label as option_label,
    e.amount,
    coalesce(sp.amount, 0)::bigint as payout,
    (case
      when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
      when e.status = 'LOST' then -e.amount
      when e.status in ('VOID', 'REFUNDED') then coalesce(refund.refund_amount, 0) - e.amount
      else 0
    end)::bigint as net_result,
    case when pt.total_pot > 0 then round(po.total_entry_amount::numeric / pt.total_pot * 100, 1) else null end as final_option_share,
    e.status::text,
    e.created_at
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.fixtures f on f.id = p.fixture_id
  join public.pool_options po on po.id = e.option_id
  left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
  left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
  left join lateral (
    select coalesce(sum(wt.amount), 0) as refund_amount
    from public.wallet_transactions wt
    where wt.entry_id = e.id and wt.type = 'pool_refund_credit'
  ) refund on true
  left join pool_totals pt on pt.pool_id = e.pool_id
  where e.user_id = auth.uid()
    and (case
      when p_order = 'recent' then e.status in ('WON', 'LOST', 'VOID', 'REFUNDED')
      else e.status in ('WON', 'LOST')
    end)
    and (case
      when p_order = 'recent' then true
      else (p_date_from is null or e.created_at >= p_date_from) and (p_date_to is null or e.created_at < p_date_to)
    end)
  order by
    case when p_order = 'recent' then e.created_at end desc,
    case when p_order = 'recent' then e.id end desc,
    case when p_order = 'chronological' then e.created_at end asc,
    case when p_order = 'chronological' then e.id end asc,
    case when p_order = 'best' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end desc,
    case when p_order = 'worst' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end asc
  limit p_limit;
$$;

-- New: opening-balance-aware account balance series. The old approach
-- (a plain range filter on wallet_transactions) would start the graph at
-- whatever the balance happened to be after the first in-range
-- transaction, not the true balance at the start of the range.
create or replace function public.get_user_bankroll_balance(
  p_date_from timestamptz,
  p_date_to timestamptz
)
returns table (bucket_timestamp timestamptz, value bigint)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_opening bigint;
begin
  select coalesce(
    (select balance_after from public.wallet_transactions
     where user_id = auth.uid() and account_type = 'user' and created_at < p_date_from
     order by created_at desc, id desc
     limit 1),
    0
  ) into v_opening;

  return query select p_date_from, v_opening;

  return query
  select wt.created_at, wt.balance_after
  from public.wallet_transactions wt
  where wt.user_id = auth.uid() and wt.account_type = 'user'
    and wt.created_at >= p_date_from and wt.created_at < p_date_to
  order by wt.created_at, wt.id;
end;
$$;

revoke all on function public.get_user_bankroll_balance(timestamptz, timestamptz) from public;
grant execute on function public.get_user_bankroll_balance(timestamptz, timestamptz) to authenticated, service_role;

-- New: cumulative P&L as a real bucketed time series, computed entirely
-- in SQL (group by + window function), replacing the old approach of
-- fetching up to 5000 raw per-entry rows and summing them in TypeScript
-- (which silently truncated past 5000 entries and returned one point per
-- entry rather than a bounded number of buckets).
create or replace function public.get_user_cumulative_pnl(
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_granularity text default 'month'
)
returns table (bucket timestamptz, bucket_net_result bigint, cumulative_net_result bigint)
language sql
security definer
set search_path = public
stable
as $$
  with graded as (
    select
      date_trunc(
        case when p_granularity in ('day', 'week', 'month') then p_granularity else 'month' end,
        e.created_at
      ) as bucket,
      (case
        when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount
        when e.status = 'LOST' then -e.amount
        else 0
      end)::bigint as net_result
    from public.entries e
    join public.pools p on p.id = e.pool_id
    left join public.settlements s on s.pool_id = p.id and s.grading_version = p.snapshot_version
    left join public.settlement_payouts sp on sp.settlement_id = s.id and sp.entry_id = e.id
    where e.user_id = auth.uid()
      and e.status in ('WON', 'LOST')
      and e.created_at >= p_date_from
      and e.created_at < p_date_to
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

revoke all on function public.get_user_cumulative_pnl(timestamptz, timestamptz, text) from public;
grant execute on function public.get_user_cumulative_pnl(timestamptz, timestamptz, text) to authenticated, service_role;
