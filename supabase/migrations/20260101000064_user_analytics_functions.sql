-- Analytics Phase 1/2: user-facing analytics ("/graphs"). Five read-only
-- reporting functions, all self-scoped via auth.uid() internally (never a
-- caller-supplied user id) so there is no parameter-based cross-user
-- leakage possible — matches "authorization must be enforced server-side"
-- from the spec. security definer + stable, mirroring get_profile_stats'/
-- get_leaderboard's existing shape, so these keep working regardless of
-- the caller's own RLS grants on entries/pools/fixtures/pool_options.
--
-- Net-result convention used identically across every function below (one
-- formula, one place, per "never let separate pages define profitability
-- differently"): for a WON entry, net = payout - stake; for a LOST entry,
-- net = -stake; VOID/REFUNDED entries contribute 0 (assumes a full
-- refund — the rare partial-fee-retained combo-void edge case is a known,
-- documented simplification, not a miscalculation of the common case).
-- ACTIVE (still open, ungraded) entries never contribute to net_result.
--
-- Two different date anchors are used deliberately: entries.created_at
-- for entry counts and money grouping (so results are "cohorted" by when
-- you entered, regardless of how long settlement took), and a separate,
-- unfiltered "recent" mode on get_user_entry_history for the streak
-- timeline, which per spec must show the last 20 graded entries
-- regardless of the page's selected date range.

-- ---------------------------------------------------------------------
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
        else 0
      end
    ), 0)::bigint as net_result,
    count(*) filter (where e.status = 'WON')::integer as wins,
    count(*) filter (where e.status = 'LOST')::integer as losses,
    count(*) filter (where e.status in ('VOID', 'REFUNDED'))::integer as voids,
    count(*) filter (where e.status in ('WON', 'LOST'))::integer as graded_entries
  from public.entries e
  left join public.settlement_payouts sp on sp.entry_id = e.id
  where e.user_id = auth.uid()
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to);
$$;

revoke all on function public.get_user_analytics_overview(timestamptz, timestamptz) from public;
grant execute on function public.get_user_analytics_overview(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Grouped by (pool_type, template_id) — deliberately NOT resolved to a
-- human category label here. That mapping (registry categories for
-- TEMPLATE_GRADED + a small legacy-type lookup) lives once, in
-- lib/pools/templates — this function stays a thin, reusable aggregate so
-- the label logic is never duplicated in SQL.
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
  left join public.settlement_payouts sp on sp.entry_id = e.id
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by p.pool_type, p.template_id;
$$;

revoke all on function public.get_user_category_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_user_category_performance(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Inner-joins fixtures, which naturally excludes CUSTOM pools (no
-- fixture_id) from this breakdown rather than miscounting them into a
-- fake "Other" competition bucket.
create or replace function public.get_user_competition_performance(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
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
    f.competition_name,
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
  left join public.settlement_payouts sp on sp.entry_id = e.id
  where e.user_id = auth.uid()
    and e.status in ('WON', 'LOST')
    and f.competition_name is not null
    and (p_date_from is null or e.created_at >= p_date_from)
    and (p_date_to is null or e.created_at < p_date_to)
  group by f.competition_name;
$$;

revoke all on function public.get_user_competition_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_user_competition_performance(timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- pools_entered counts every status (a plain participation count, like
-- the overview) — entry_volume/payouts/net_result zero out non-graded
-- entries via the same CASE convention used everywhere else in this file.
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
        else 0
      end
    ), 0)::bigint as net_result
  from public.entries e
  left join public.settlement_payouts sp on sp.entry_id = e.id
  where e.user_id = auth.uid()
    and e.created_at >= p_date_from
    and e.created_at < p_date_to
  group by 1
  order by 1;
$$;

revoke all on function public.get_user_monthly_activity(timestamptz, timestamptz, text) from public;
grant execute on function public.get_user_monthly_activity(timestamptz, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Serves both the streak timeline (p_order = 'recent': last N graded
-- entries including VOID/REFUNDED so the timeline can render them,
-- ignoring the page's date filter entirely per spec) and "biggest wins
-- and losses" (p_order = 'best'/'worst': WON/LOST only, ranked by
-- net_result, respecting the selected date range). Only one of the three
-- ORDER BY expressions below is ever non-null for a given call (the
-- other two evaluate to NULL for every row alike), so they don't perturb
-- each other's ordering.
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
      else 0
    end)::bigint as net_result,
    case when pt.total_pot > 0 then round(po.total_entry_amount::numeric / pt.total_pot * 100, 1) else null end as final_option_share,
    e.status::text,
    e.created_at
  from public.entries e
  join public.pools p on p.id = e.pool_id
  left join public.fixtures f on f.id = p.fixture_id
  join public.pool_options po on po.id = e.option_id
  left join public.settlement_payouts sp on sp.entry_id = e.id
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
    case when p_order = 'best' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end desc,
    case when p_order = 'worst' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end asc
  limit p_limit;
$$;

revoke all on function public.get_user_entry_history(timestamptz, timestamptz, text, integer) from public;
grant execute on function public.get_user_entry_history(timestamptz, timestamptz, text, integer) to authenticated, service_role;
