-- Phase 1.5: normal settlement becomes fully automatic for TEMPLATE_GRADED
-- pools whose outcome is unambiguous. Previously gradeTemplatePool
-- (lib/pools/templates/grade.ts) stopped at a proposed settlement
-- (READY_FOR_REVIEW) and always required one admin confirm click to
-- actually move money — by design at the time, per
-- 20260101000047_defense_in_depth_role_checks.sql's own comment:
-- "confirm_pool_refund is the ONE exception with a conditional [admin]
-- check ... for fully-automatic system reasons." Extending that same,
-- already-established exception to confirm_pool_settlement is what makes
-- automatic settlement possible here — grade.ts now calls this RPC itself
-- immediately after preparing the settlement, with p_admin_id = null,
-- exactly mirroring how automatic refunds already call confirm_pool_refund
-- with p_admin_id = null.
--
-- Nothing about the human path changes: any non-null p_admin_id must still
-- resolve to a real, active super_admin, identical to before. Only a null
-- p_admin_id — reachable exclusively from server-side code, never from any
-- client input — is now permitted through, gated by the same CRON_SECRET-
-- protected route (or, for the "Check for result now" admin button,
-- requireSuperAdmin() at the Server Action layer) the automatic refund
-- path already relies on for that same guarantee.
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
  if p_admin_id is not null and not public.is_super_admin(p_admin_id) then
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
      -- Rare: the determined winner happens to be a no-winner/all-winner
      -- case (e.g. a legacy TEMPLATE_GRADED pool created before the
      -- one-sided-pool lock-time guard existed). Bail out to the refund
      -- path rather than silently settling — for the automatic caller,
      -- this exception is caught by grade.ts, which leaves the pool at
      -- READY_FOR_REVIEW for a human to resolve via confirm_pool_refund,
      -- exactly the pre-existing fallback.
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
