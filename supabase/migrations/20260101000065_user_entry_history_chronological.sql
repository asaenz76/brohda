-- Adds a 4th ordering mode to get_user_entry_history: 'chronological'
-- (oldest-first, WON/LOST only, respects the date range, no small limit)
-- — needed for the "cumulative pool P&L" bankroll graph mode, which sums
-- net_result running-total across every graded entry in the selected
-- range in date order, not just the last N. Never edit an already-applied
-- migration; this replaces the function wholesale (functions are always
-- CREATE OR REPLACE, not patched).
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
    case when p_order = 'chronological' then e.created_at end asc,
    case when p_order = 'best' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end desc,
    case when p_order = 'worst' then
      (case when e.status = 'WON' then coalesce(sp.amount, 0) - e.amount else -e.amount end)
    end asc
  limit p_limit;
$$;
