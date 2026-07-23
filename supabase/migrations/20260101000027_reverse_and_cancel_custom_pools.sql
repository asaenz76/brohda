-- Full lifecycle parity for CUSTOM pools (and any pool settled via the
-- "Grade Manually" override, real-fixture or not):
--
-- 1. confirm_pool_refund: ADMIN_MANUAL_CANCEL is a super_admin cancelling a
--    pool outright (not an automatic anomaly/below-minimum trigger). It maps
--    to CANCELLED, matching the existing "this didn't really happen"
--    semantics of MINIMUM_ENTRIES_NOT_REACHED, distinct from VOIDED's
--    "something went wrong with the match/anomaly".
--
-- 2. prepare_pool_settlement_manual: widen the status guard to also accept
--    SETTLEMENT_REVERSED, mirroring how prepare_pool_settlement was already
--    widened for the identical reason (20260101000011_reversal_and_reporting.sql).
--    Without this, reversing a manually-graded pool leaves it permanently
--    stuck on SETTLEMENT_REVERSED since Grade Manually would refuse it.
--
-- 3. reverse_pool_settlement: the final re-settle call unconditionally
--    invoked the fixture-dependent prepare_pool_settlement, raising
--    fixture_not_found for any pool with no fixture_id (a CUSTOM pool) or
--    even a real-fixture pool that happened to be settled via Grade
--    Manually. Branch on v_pool.fixture_id instead: null routes to the
--    manual path, otherwise keep using the automatic one (so a real-fixture
--    pool reversed after a manual grade still gets a chance to resolve
--    automatically from live fixture data, per spec's "corrected result"
--    scenario). Based on the 20260101000018_leaderboard.sql version of this
--    function (not the original 20260101000011 one) — that migration added
--    the correct_prediction_log/streak rollback block below, which must be
--    preserved here.

create or replace function public.confirm_pool_refund(
  p_pool_id uuid,
  p_void_reason public.pool_void_reason,
  p_idempotency_key text,
  p_admin_id uuid default null,
  p_grading_version integer default null
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
  v_entry record;
  v_new_status public.pool_status;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status in (
    'SETTLED', 'VOIDED', 'CANCELLED', 'SETTLEMENT_REVERSED', 'REVERSAL_FAILED_MANUAL_REVIEW'
  ) then
    return v_pool; -- already terminal — idempotent no-op
  end if;

  if p_grading_version is not null then
    if v_pool.snapshot_version <> p_grading_version then
      raise exception 'stale_snapshot';
    end if;

    select * into v_settlement from public.settlements
      where pool_id = p_pool_id and grading_version = p_grading_version for update;
  end if;

  v_new_status := case when p_void_reason in ('MINIMUM_ENTRIES_NOT_REACHED', 'ADMIN_MANUAL_CANCEL')
    then 'CANCELLED'::public.pool_status else 'VOIDED'::public.pool_status end;

  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'ACTIVE' for update
  loop
    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_entry.user_id,
      'pool_refund_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_entry.amount,
      p_admin_id,
      p_void_reason::text,
      p_idempotency_key || ':refund:' || v_entry.id,
      p_pool_id, v_entry.id, null
    );

    update public.entries set status = 'REFUNDED' where id = v_entry.id;
  end loop;

  update public.pools set status = v_new_status, void_reason = p_void_reason where id = p_pool_id;

  if v_settlement.id is not null then
    update public.settlements
    set confirmed_by_admin_id = p_admin_id, confirmed_at = now()
    where id = v_settlement.id;
  end if;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.confirm_pool_refund(uuid, public.pool_void_reason, text, uuid, integer) from public;
grant execute on function public.confirm_pool_refund(uuid, public.pool_void_reason, text, uuid, integer) to service_role;

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

  if v_pool.status not in ('LOCKED', 'AWAITING_RESULT', 'SETTLEMENT_REVERSED') then
    raise exception 'pool_not_gradable';
  end if;

  select coalesce(sum(entry_count), 0), coalesce(sum(total_entry_amount), 0)
    into v_total_valid_entries, v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

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

create or replace function public.reverse_pool_settlement(
  p_pool_id uuid,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
  v_payout record;
  v_balance bigint;
  v_all_ok boolean := true;
  v_report jsonb := '[]'::jsonb;
  v_house_debit bigint;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status not in ('SETTLED', 'REVERSAL_FAILED_MANUAL_REVIEW') then
    raise exception 'pool_not_reversible';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = v_pool.snapshot_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is null then
    raise exception 'settlement_not_confirmed';
  end if;

  if v_settlement.reversed_at is not null then
    return v_pool; -- already reversed — idempotent no-op
  end if;

  -- Dry run: lock every winner's balance row and check it can absorb the
  -- clawback. Pure reads/locks — nothing written yet.
  for v_payout in
    select sp.entry_id, sp.amount, e.user_id
    from public.settlement_payouts sp
    join public.entries e on e.id = sp.entry_id
    where sp.settlement_id = v_settlement.id
  loop
    select balance into v_balance
      from public.wallet_balances where user_id = v_payout.user_id and account_type = 'user'
      for update;

    v_report := v_report || jsonb_build_object(
      'userId', v_payout.user_id,
      'creditedAmount', v_payout.amount,
      'currentBalance', v_balance,
      'shortfall', greatest(v_payout.amount - v_balance, 0)
    );

    if v_balance < v_payout.amount then
      v_all_ok := false;
    end if;
  end loop;

  if not v_all_ok then
    -- reversal_reason is stamped here too (not just on success) purely so
    -- the admin's retry form can pre-fill it — reversed_at/reversed_by_
    -- admin_id stay null since nothing was actually reversed yet.
    update public.settlements
    set reversal_shortfall_report = v_report, reversal_reason = p_reason
    where id = v_settlement.id;
    update public.pools set status = 'REVERSAL_FAILED_MANUAL_REVIEW' where id = p_pool_id;

    select * into v_pool from public.pools where id = p_pool_id;
    return v_pool;
  end if;

  -- Every winner can absorb it — execute the compensating debits.
  for v_payout in
    select sp.entry_id, sp.amount, e.user_id
    from public.settlement_payouts sp
    join public.entries e on e.id = sp.entry_id
    where sp.settlement_id = v_settlement.id
  loop
    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_payout.user_id,
      'settlement_reversal_debit'::public.wallet_transaction_type,
      'debit'::public.wallet_direction,
      v_payout.amount,
      p_admin_id,
      p_reason,
      p_idempotency_key || ':reversal:' || v_payout.entry_id,
      p_pool_id, v_payout.entry_id, v_settlement.id
    );

    -- Undo the correct-prediction count/streak/log this winner picked up
    -- when this (now-reversed) settlement first confirmed.
    delete from public.correct_prediction_log
    where settlement_id = v_settlement.id and user_id = v_payout.user_id;

    update public.user_profiles
    set correct_predictions_count = greatest(correct_predictions_count - 1, 0),
        current_streak = greatest(current_streak - 1, 0)
    where id = v_payout.user_id;
  end loop;

  v_house_debit := v_settlement.house_fee_amount + v_settlement.rounding_remainder;
  if v_house_debit > 0 then
    perform public.apply_wallet_transaction(
      'house'::public.wallet_account_type,
      null,
      'settlement_reversal_debit'::public.wallet_transaction_type,
      'debit'::public.wallet_direction,
      v_house_debit,
      p_admin_id,
      p_reason,
      p_idempotency_key || ':reversal:house',
      p_pool_id, null, v_settlement.id
    );
  end if;

  -- Reset entries/options so the re-settlement below (and its eventual
  -- confirm_pool_settlement call) grades from a clean slate rather than
  -- leaving stale WON/LOST/is_winning_option state from this reversed
  -- attempt lingering if the new result differs.
  update public.entries set status = 'ACTIVE'
    where pool_id = p_pool_id and status in ('WON', 'LOST');
  update public.pool_options set is_winning_option = false where pool_id = p_pool_id;

  update public.settlements
  set reversed_at = now(), reversed_by_admin_id = p_admin_id, reversal_reason = p_reason
  where id = v_settlement.id;

  update public.pools
  set snapshot_version = snapshot_version + 1, status = 'SETTLEMENT_REVERSED'
  where id = p_pool_id;

  -- Immediately re-settle, landing on READY_FOR_REVIEW with a fresh
  -- snapshot (spec §17.3). A pool with no fixture (CUSTOM, or a
  -- real-fixture pool that had been settled via Grade Manually while its
  -- fixture data was unavailable) can't go through the automatic path —
  -- route it back through the manual one instead.
  if v_pool.fixture_id is null then
    perform public.prepare_pool_settlement_manual(p_pool_id);
  else
    perform public.prepare_pool_settlement(p_pool_id);
  end if;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.reverse_pool_settlement(uuid, uuid, text, text) from public;
grant execute on function public.reverse_pool_settlement(uuid, uuid, text, text) to service_role;
