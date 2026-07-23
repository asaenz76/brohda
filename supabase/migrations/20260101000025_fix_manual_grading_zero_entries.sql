-- Fixes prepare_pool_settlement_manual (20260101000024_custom_pools_grading.sql):
-- it hard-coded outcome='NORMAL' regardless of whether the pool had any
-- entries at all. A pool with zero entries can never have a valid winner no
-- matter which option gets picked later — confirm_pool_settlement's own
-- no_or_all_winner guard already catches this, but only after the admin
-- picks a winner and submits, surfacing as an unrelated "stale settlement"
-- error instead of the refund flow that already exists for exactly this
-- case. Detecting it upfront (same as prepare_pool_settlement already does
-- for the automatic path) routes straight to that existing refund UI.
create or replace function public.prepare_pool_settlement_manual(p_pool_id uuid)
returns public.settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_existing public.settlements;
  v_gross_pool bigint;
  v_total_valid_entries integer;
  v_requires_manual boolean := true;
  v_outcome text := 'NORMAL';
  v_result public.settlements;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  select * into v_existing from public.settlements
    where pool_id = p_pool_id and grading_version = v_pool.snapshot_version;
  if found then
    return v_existing;
  end if;

  if v_pool.status not in ('LOCKED', 'AWAITING_RESULT') then
    raise exception 'pool_not_gradable';
  end if;

  select coalesce(sum(entry_count), 0), coalesce(sum(total_entry_amount), 0)
    into v_total_valid_entries, v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

  -- No entries at all -> every option would be a no-winner refund regardless
  -- of what an admin later picks, so there's nothing to manually verify.
  if v_total_valid_entries = 0 then
    v_requires_manual := false;
    v_outcome := 'NO_WINNING_ENTRIES_REFUND';
  end if;

  insert into public.settlements (
    pool_id, grading_version, provider_status,
    winning_option_id, winning_option_reason, requires_manual_verification,
    gross_pool, house_fee_bps, house_fee_amount, net_prize_pool,
    winning_entry_count, payout_per_entry, rounding_remainder, outcome
  ) values (
    p_pool_id, v_pool.snapshot_version, 'MANUAL',
    null, null, v_requires_manual,
    v_gross_pool, v_pool.house_fee_bps, 0, 0, null, 0, 0, v_outcome
  ) returning * into v_result;

  update public.pools set status = 'READY_FOR_REVIEW' where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.prepare_pool_settlement_manual(uuid) from public;
grant execute on function public.prepare_pool_settlement_manual(uuid) to service_role;
