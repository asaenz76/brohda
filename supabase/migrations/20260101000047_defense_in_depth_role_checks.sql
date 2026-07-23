-- Defense-in-depth: every money-moving / destructive SECURITY DEFINER
-- function below is service_role-only (revoked from PUBLIC), so today the
-- *entire* authorization boundary is "did the calling Server Action
-- remember to call requireSuperAdmin() first." That's true everywhere
-- right now, but it's a single point of failure — a future Server Action
-- that forgets that call would have unrestricted access, since the service
-- role bypasses RLS entirely. This migration adds the same check the app
-- layer already performs, a second time, inside each function itself.
--
-- `confirm_pool_refund` is the one exception with a *conditional* check:
-- it's also called with p_admin_id = null for fully-automatic system
-- reasons (MINIMUM_ENTRIES_NOT_REACHED at lock time, X.7 anomaly voids from
-- the process-results cron) where there is no human caller to validate —
-- those paths are already gated by the cron route's own CRON_SECRET check,
-- not by this function.
--
-- `abort_pool_reversal` and `delete_terminal_pool` didn't take an admin id
-- parameter at all before this migration — both gain one here (a genuine
-- signature change, hence the explicit drops below) purely so there's an
-- identity to check against. Every existing caller already has the admin's
-- id in hand (requireSuperAdmin()'s return value); only the RPC call sites
-- need updating to pass it.

create or replace function public.confirm_pool_settlement(
  p_pool_id uuid,
  p_admin_id uuid,
  p_grading_version integer,
  p_idempotency_key text,
  p_winning_option_id uuid default null
)
returns public.settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
  v_winning_option_id uuid;
  v_winning_entry_count integer;
  v_total_valid_entries integer;
  v_house_fee_amount bigint;
  v_net_prize_pool bigint;
  v_payout_per_entry bigint;
  v_rounding_remainder bigint;
  v_entry record;
  v_result public.settlements;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = p_grading_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    return v_settlement;
  end if;

  if v_pool.status <> 'READY_FOR_REVIEW' then
    raise exception 'pool_not_ready_for_review';
  end if;

  if v_pool.snapshot_version <> p_grading_version then
    raise exception 'stale_snapshot';
  end if;

  if v_settlement.outcome <> 'NORMAL' then
    raise exception 'use_confirm_pool_refund';
  end if;

  v_winning_option_id := v_settlement.winning_option_id;
  v_house_fee_amount := v_settlement.house_fee_amount;
  v_net_prize_pool := v_settlement.net_prize_pool;
  v_winning_entry_count := v_settlement.winning_entry_count;
  v_payout_per_entry := v_settlement.payout_per_entry;
  v_rounding_remainder := v_settlement.rounding_remainder;

  if v_settlement.requires_manual_verification then
    if p_winning_option_id is null then
      raise exception 'winning_option_required';
    end if;
    if not exists (
      select 1 from public.pool_options where id = p_winning_option_id and pool_id = p_pool_id
    ) then
      raise exception 'invalid_winning_option';
    end if;

    v_winning_option_id := p_winning_option_id;
    select entry_count into v_winning_entry_count
      from public.pool_options where id = v_winning_option_id;
    select coalesce(sum(entry_count), 0) into v_total_valid_entries
      from public.pool_options where pool_id = p_pool_id;

    if v_winning_entry_count = 0 or v_winning_entry_count = v_total_valid_entries then
      -- Rare: the admin's manual pick happens to be a no-winner/all-winner
      -- case. Bail out to the refund path rather than silently settling.
      raise exception 'no_or_all_winner_use_confirm_pool_refund';
    end if;

    v_house_fee_amount := (v_settlement.gross_pool * v_pool.house_fee_bps) / 10000;
    v_net_prize_pool := v_settlement.gross_pool - v_house_fee_amount;
    v_payout_per_entry := v_net_prize_pool / v_winning_entry_count;
    v_rounding_remainder := v_net_prize_pool - (v_payout_per_entry * v_winning_entry_count);

    update public.settlements set
      winning_option_id = v_winning_option_id,
      winning_option_reason = 'MANUAL_ADMIN_OVERRIDE',
      house_fee_amount = v_house_fee_amount,
      net_prize_pool = v_net_prize_pool,
      winning_entry_count = v_winning_entry_count,
      payout_per_entry = v_payout_per_entry,
      rounding_remainder = v_rounding_remainder
    where id = v_settlement.id;
  end if;

  update public.entries set status = 'WON'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id = v_winning_option_id;
  update public.entries set status = 'LOST'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id <> v_winning_option_id;

  update public.user_profiles
  set current_streak = 0
  where id in (select user_id from public.entries where pool_id = p_pool_id and status = 'LOST');

  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'WON'
  loop
    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_entry.user_id,
      'pool_payout_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_payout_per_entry,
      null, null,
      p_idempotency_key || ':payout:' || v_entry.id,
      p_pool_id, v_entry.id, v_settlement.id
    );

    insert into public.settlement_payouts (settlement_id, entry_id, amount)
    values (v_settlement.id, v_entry.id, v_payout_per_entry)
    on conflict (settlement_id, entry_id) do nothing;

    insert into public.correct_prediction_log (user_id, pool_id, settlement_id)
    values (v_entry.user_id, p_pool_id, v_settlement.id);

    update public.user_profiles
    set correct_predictions_count = correct_predictions_count + 1,
        current_streak = current_streak + 1,
        best_streak = greatest(best_streak, current_streak + 1)
    where id = v_entry.user_id;
  end loop;

  if v_house_fee_amount > 0 then
    perform public.apply_wallet_transaction(
      'house'::public.wallet_account_type,
      null,
      'house_fee_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_house_fee_amount,
      null, null,
      p_idempotency_key || ':house_fee',
      p_pool_id, null, v_settlement.id
    );
  end if;

  if v_rounding_remainder > 0 then
    perform public.apply_wallet_transaction(
      'house'::public.wallet_account_type,
      null,
      'rounding_remainder_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_rounding_remainder,
      null, null,
      p_idempotency_key || ':remainder',
      p_pool_id, null, v_settlement.id
    );
  end if;

  update public.pool_options set is_winning_option = true where id = v_winning_option_id;

  update public.settlements
  set confirmed_by_admin_id = p_admin_id, confirmed_at = now()
  where id = v_settlement.id
  returning * into v_result;

  update public.pools set status = 'SETTLED' where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.confirm_pool_settlement(uuid, uuid, integer, text, uuid) from public;
grant execute on function public.confirm_pool_settlement(uuid, uuid, integer, text, uuid) to service_role;

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
  -- p_admin_id is null for fully-automatic system calls (below-minimum-
  -- entries cancellation at lock time, X.7 anomaly voids from the
  -- process-results cron) — those are gated by the cron route's own
  -- CRON_SECRET check, not by a human identity here.
  if p_admin_id is not null and not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

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

create or replace function public.confirm_combo_refund_fee_retained(
  p_pool_id uuid,
  p_admin_id uuid,
  p_grading_version integer,
  p_idempotency_key text,
  p_winning_option_id uuid
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
  v_entry_fee bigint;
  v_entry_net bigint;
  v_total_fee bigint := 0;
  v_gross_pool bigint;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status in (
    'SETTLED', 'VOIDED', 'CANCELLED', 'SETTLEMENT_REVERSED', 'REVERSAL_FAILED_MANUAL_REVIEW'
  ) then
    return v_pool; -- already terminal — idempotent no-op, mirrors confirm_pool_refund
  end if;

  if v_pool.snapshot_version <> p_grading_version then
    raise exception 'stale_snapshot';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = p_grading_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    return v_pool; -- already confirmed — idempotent no-op
  end if;

  select coalesce(sum(total_entry_amount), 0) into v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'ACTIVE' for update
  loop
    v_entry_fee := (v_entry.amount * v_pool.house_fee_bps) / 10000;
    v_entry_net := v_entry.amount - v_entry_fee;
    v_total_fee := v_total_fee + v_entry_fee;

    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_entry.user_id,
      'pool_refund_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_entry_net,
      p_admin_id,
      'NO_WINNING_ENTRIES_FEE_RETAINED',
      p_idempotency_key || ':refund:' || v_entry.id,
      p_pool_id, v_entry.id, v_settlement.id
    );

    update public.entries set status = 'REFUNDED' where id = v_entry.id;
  end loop;

  if v_total_fee > 0 then
    perform public.apply_wallet_transaction(
      'house'::public.wallet_account_type,
      null,
      'house_fee_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_total_fee,
      p_admin_id,
      'NO_WINNING_ENTRIES_FEE_RETAINED',
      p_idempotency_key || ':house_fee',
      p_pool_id, null, v_settlement.id
    );
  end if;

  update public.settlements
  set winning_option_id = p_winning_option_id,
      gross_pool = v_gross_pool,
      house_fee_bps = v_pool.house_fee_bps,
      house_fee_amount = v_total_fee,
      net_prize_pool = 0,
      winning_entry_count = 0,
      payout_per_entry = 0,
      outcome = 'NO_WINNING_ENTRIES_FEE_RETAINED',
      confirmed_by_admin_id = p_admin_id,
      confirmed_at = now()
  where id = v_settlement.id;

  update public.pools
  set status = 'VOIDED', void_reason = 'NO_WINNING_ENTRIES_FEE_RETAINED'
  where id = p_pool_id;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.confirm_combo_refund_fee_retained(uuid, uuid, integer, text, uuid) from public;
grant execute on function public.confirm_combo_refund_fee_retained(uuid, uuid, integer, text, uuid) to service_role;

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
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

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

  update public.entries set status = 'ACTIVE'
    where pool_id = p_pool_id and status in ('WON', 'LOST');
  update public.pool_options set is_winning_option = false where pool_id = p_pool_id;

  update public.settlements
  set reversed_at = now(), reversed_by_admin_id = p_admin_id, reversal_reason = p_reason
  where id = v_settlement.id;

  update public.pools
  set snapshot_version = snapshot_version + 1, status = 'SETTLEMENT_REVERSED'
  where id = p_pool_id;

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

create or replace function public.void_pool_entry(
  p_entry_id uuid,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns public.entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.entries;
  v_pool public.pools;
  v_result public.entries;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_entry from public.entries where id = p_entry_id for update;
  if not found then
    raise exception 'entry_not_found';
  end if;
  if v_entry.status <> 'ACTIVE' then
    raise exception 'entry_not_active';
  end if;

  select * into v_pool from public.pools where id = v_entry.pool_id for update;
  if v_pool.status <> 'OPEN' then
    raise exception 'pool_not_open';
  end if;

  update public.entries
  set status = 'VOID'
  where id = p_entry_id
  returning * into v_result;

  update public.pool_options
  set entry_count = entry_count - 1, total_entry_amount = total_entry_amount - v_entry.amount
  where id = v_entry.option_id;

  perform public.apply_wallet_transaction(
    'user'::public.wallet_account_type,
    v_entry.user_id,
    'pool_refund_credit'::public.wallet_transaction_type,
    'credit'::public.wallet_direction,
    v_entry.amount,
    p_admin_id,
    p_reason,
    p_idempotency_key,
    v_pool.id,
    v_entry.id,
    null
  );

  return v_result;
end;
$$;

revoke all on function public.void_pool_entry(uuid, uuid, text, text) from public;
grant execute on function public.void_pool_entry(uuid, uuid, text, text) to service_role;

create or replace function public.undo_pool_grading(
  p_pool_id uuid,
  p_admin_id uuid
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status <> 'READY_FOR_REVIEW' then
    raise exception 'pool_not_pending_review';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = v_pool.snapshot_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    raise exception 'settlement_already_confirmed';
  end if;

  delete from public.settlements where id = v_settlement.id;
  update public.pool_options set is_winning_option = false where pool_id = p_pool_id;
  update public.pools set status = 'LOCKED' where id = p_pool_id;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.undo_pool_grading(uuid, uuid) from public;
grant execute on function public.undo_pool_grading(uuid, uuid) to service_role;

-- abort_pool_reversal previously took only p_pool_id — no identity to check
-- against. Adding p_admin_id is a real signature change, so the old 1-arg
-- overload is dropped rather than replaced in place.
drop function if exists public.abort_pool_reversal(uuid);

create or replace function public.abort_pool_reversal(p_pool_id uuid, p_admin_id uuid)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status <> 'REVERSAL_FAILED_MANUAL_REVIEW' then
    raise exception 'pool_not_in_manual_review';
  end if;

  update public.pools set status = 'SETTLED' where id = p_pool_id;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.abort_pool_reversal(uuid, uuid) from public;
grant execute on function public.abort_pool_reversal(uuid, uuid) to service_role;

-- delete_terminal_pool previously took only p_pool_id, same reasoning as
-- abort_pool_reversal above.
drop function if exists public.delete_terminal_pool(uuid);

create or replace function public.delete_terminal_pool(
  p_pool_id uuid,
  p_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_entry record;
  v_settlement_ids uuid[];
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.first_entry_at is not null and v_pool.status not in ('SETTLED', 'CANCELLED', 'VOIDED') then
    raise exception 'pool_not_deletable';
  end if;

  for v_entry in
    select user_id from public.entries where pool_id = p_pool_id and status = 'WON'
  loop
    update public.user_profiles
    set correct_predictions_count = greatest(correct_predictions_count - 1, 0),
        current_streak = greatest(current_streak - 1, 0)
    where id = v_entry.user_id;
  end loop;

  select array_agg(id) into v_settlement_ids from public.settlements where pool_id = p_pool_id;

  if v_settlement_ids is not null then
    delete from public.settlement_payouts where settlement_id = any(v_settlement_ids);
  end if;
  delete from public.correct_prediction_log where pool_id = p_pool_id;
  delete from public.entries where pool_id = p_pool_id;
  delete from public.settlements where pool_id = p_pool_id;
  delete from public.pool_combo_legs where pool_id = p_pool_id;
  delete from public.pool_options where pool_id = p_pool_id;
  update public.notifications set pool_id = null where pool_id = p_pool_id;

  delete from public.pools where id = p_pool_id;
end;
$$;

revoke all on function public.delete_terminal_pool(uuid, uuid) from public;
grant execute on function public.delete_terminal_pool(uuid, uuid) to service_role;
