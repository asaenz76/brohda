-- FREE prediction mode — Phase 4 completion (remaining analytics audit,
-- release-gate follow-up).
--
-- Per-column classification for both functions, financial vs. engagement,
-- per the locked rule (financial = PAID only, engagement = PAID+FREE):
--
-- get_platform_category_performance:
--   entries        FINANCIAL  — plain count(*), does NOT self-exclude FREE
--                               (a FREE row has no amount, but count(*)
--                               counts it anyway) — FIXED below.
--   entry_volume   FINANCIAL  — sum(e.amount); FREE's amount is null, SUM
--                               already skips nulls — no change needed.
--   net_result     FINANCIAL  — sum(... e.amount ...); same null-skipping
--                               arithmetic as get_platform_top_users — a
--                               FREE row's contribution is already null and
--                               already skipped — no change needed.
--   wins / losses  ENGAGEMENT — accuracy, not money. confirm_pool_grading_
--                               only marks FREE entries WON/LOST through
--                               the identical grading path a PAID entry
--                               uses — left combined, unchanged, exactly
--                               like get_platform_overview's wins/losses.
--
-- get_platform_monthly_activity (every column here is financial — there is
-- no accuracy/engagement column in this function at all):
--   pools_entered  FINANCIAL  — plain count(*), does NOT self-exclude —
--                               FIXED below.
--   entry_volume   FINANCIAL  — sum(...); already null-skips — no change.
--   payouts        FINANCIAL  — sum(case when WON then coalesce(wt.amount,0)
--                               else 0 end): a FREE WON entry has no
--                               wallet_transactions row, so coalesce(...,0)
--                               already contributes exactly 0 (mathematically
--                               identical to exclusion for a SUM) — no
--                               change needed.
--   net_result     FINANCIAL  — same null-skipping arithmetic as the
--                               functions above (WON/LOST branches null out
--                               via e.amount; the VOID/REFUNDED branch's
--                               `coalesce(refund.refund_amount, 0) -
--                               e.amount` also nulls out via e.amount) — no
--                               change needed.
--
-- Only two lines actually change across both functions: `count(*)` becomes
-- `count(*) filter (where e.amount is not null)` for the one genuinely
-- financial-volume-shaped count in each. Nothing else here is touched —
-- deliberately not a mechanical "filter every count" pass.

create or replace function public.get_platform_category_performance(
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns table (
  category analytics_category,
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
  select
    p.analytics_category as category,
    count(*) filter (where e.amount is not null)::integer as entries,
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

create or replace function public.get_platform_monthly_activity(
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
stable
security definer
set search_path = public
as $$
  select
    (date_trunc(
      case when p_granularity in ('day', 'week', 'month') then p_granularity else 'month' end,
      e.created_at at time zone p_timezone
    ) at time zone p_timezone) as bucket,
    count(*) filter (where e.amount is not null)::integer as pools_entered,
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

-- create or replace preserves existing grants, but restated explicitly per
-- the RPC-grant-drift precedent — unchanged from before this migration:
-- both stay service_role-only.
revoke all on function public.get_platform_category_performance(timestamptz, timestamptz) from public;
grant execute on function public.get_platform_category_performance(timestamptz, timestamptz) to service_role;

revoke all on function public.get_platform_monthly_activity(timestamptz, timestamptz, text, text) from public;
grant execute on function public.get_platform_monthly_activity(timestamptz, timestamptz, text, text) to service_role;
