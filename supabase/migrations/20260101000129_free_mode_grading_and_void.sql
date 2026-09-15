-- FREE prediction mode — Phase 1 (grading and void siblings, §8).
--
-- Two new RPCs, mirroring confirm_pool_settlement and confirm_pool_refund
-- structurally but with every financial statement removed — no
-- apply_wallet_transaction call, no settlement_payouts insert, no
-- house_fee/net_prize_pool/payout_per_entry computation. Both functions
-- guard `entry_mode = 'FREE'` explicitly and refuse to run on a PAID pool,
-- so a dispatch mistake fails loudly instead of silently skipping a PAID
-- pool's financial settlement. Neither function reads
-- paid_pools_enabled/free_pools_enabled — grading, settlement, and void
-- never consult the platform toggle (§5.2, §8, §13's key invariant); the
-- toggle is consulted exactly once, inside create_pool_entry, at entry
-- time only.
--
-- confirm_pool_settlement, confirm_pool_refund, apply_wallet_transaction,
-- and reverse_pool_settlement receive zero modifications from this
-- migration.

create or replace function public.confirm_pool_grading_only(
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
  v_entry record;
  v_result public.settlements;
begin
  if p_admin_id is not null and not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.entry_mode <> 'FREE' then
    raise exception 'confirm_pool_grading_only_is_free_mode_only';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = p_grading_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    return v_settlement; -- idempotent no-op
  end if;

  if v_pool.status <> 'READY_FOR_REVIEW' then
    raise exception 'pool_not_ready_for_review';
  end if;

  if v_pool.snapshot_version <> p_grading_version then
    raise exception 'stale_snapshot';
  end if;

  if v_settlement.outcome <> 'NORMAL' then
    raise exception 'use_void_pool_no_refund';
  end if;

  v_winning_option_id := v_settlement.winning_option_id;

  -- prepare_pool_settlement_manual (reused unmodified for FREE pools too —
  -- §8) sets requires_manual_verification = true by default for any pool
  -- with real entries, so this branch is the normal path for an
  -- automatically-graded TEMPLATE_GRADED pool, not just literal human
  -- review — mirrors confirm_pool_settlement's identical structure exactly.
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
      raise exception 'no_or_all_winner_use_void_pool_no_refund';
    end if;

    update public.settlements set
      winning_option_id = v_winning_option_id,
      winning_option_reason = 'MANUAL_ADMIN_OVERRIDE'
    where id = v_settlement.id;
  end if;

  update public.entries set status = 'WON'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id = v_winning_option_id;
  update public.entries set status = 'LOST'
    where pool_id = p_pool_id and status = 'ACTIVE' and option_id <> v_winning_option_id;

  update public.user_profiles
  set current_streak = 0
  where id in (select user_id from public.entries where pool_id = p_pool_id and status = 'LOST');

  -- Duplicated verbatim from confirm_pool_settlement's streak/accuracy
  -- block (architecture doc §8, risk 2) rather than factored into a shared
  -- helper — deliberately, so confirm_pool_settlement itself receives zero
  -- modifications from this feature. Any future change to streak/accuracy
  -- logic must be applied to both functions.
  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'WON'
  loop
    insert into public.correct_prediction_log (user_id, pool_id, settlement_id)
    values (v_entry.user_id, p_pool_id, v_settlement.id);

    update public.user_profiles
    set correct_predictions_count = correct_predictions_count + 1,
        current_streak = current_streak + 1,
        best_streak = greatest(best_streak, current_streak + 1)
    where id = v_entry.user_id;
  end loop;

  update public.pool_options set is_winning_option = true where id = v_winning_option_id;

  update public.settlements
  set confirmed_by_admin_id = p_admin_id, confirmed_at = now()
  where id = v_settlement.id
  returning * into v_result;

  update public.pools set status = 'SETTLED' where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.confirm_pool_grading_only(uuid, uuid, integer, text, uuid) from public;
grant execute on function public.confirm_pool_grading_only(uuid, uuid, integer, text, uuid) to service_role;


create or replace function public.void_pool_no_refund(
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
  v_new_status public.pool_status;
begin
  if p_admin_id is not null and not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.entry_mode <> 'FREE' then
    raise exception 'void_pool_no_refund_is_free_mode_only';
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

  v_new_status := case when p_void_reason in ('MINIMUM_ENTRIES_NOT_REACHED', 'ADMIN_MANUAL_CANCEL', 'ONE_SIDED_POOL')
    then 'CANCELLED'::public.pool_status else 'VOIDED'::public.pool_status end;

  -- No wallet loop — a FREE entry never had a cost, so there is nothing to
  -- refund. Entries move straight to VOID (not REFUNDED, which would
  -- wrongly imply a wallet credit occurred).
  update public.entries set status = 'VOID'
  where pool_id = p_pool_id and status = 'ACTIVE';

  update public.pools
  set status = v_new_status, void_reason = p_void_reason, review_reason = null
  where id = p_pool_id;

  if v_settlement.id is not null then
    update public.settlements
    set confirmed_by_admin_id = p_admin_id, confirmed_at = now()
    where id = v_settlement.id;
  end if;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.void_pool_no_refund(uuid, public.pool_void_reason, text, uuid, integer) from public;
grant execute on function public.void_pool_no_refund(uuid, public.pool_void_reason, text, uuid, integer) to service_role;
