-- Phase 7 (Instagram-style redesign): leaderboard / rankings. The number
-- shown is a literal count of correct predictions, not points.

alter table public.user_profiles
  add column correct_predictions_count bigint not null default 0,
  add column current_streak integer not null default 0,
  add column best_streak integer not null default 0;

-- One row per correct (WON) entry at settlement time — makes weekly/
-- monthly leaderboard ranges possible (count(*) where created_at >= range
-- start) without scanning entries/settlements. All-time reads still use
-- the denormalized counters on user_profiles above for O(1) access.
create table public.correct_prediction_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  pool_id uuid not null references public.pools (id),
  settlement_id uuid not null references public.settlements (id),
  created_at timestamptz not null default now()
);

create index correct_prediction_log_user_idx on public.correct_prediction_log (user_id, created_at desc);
create index correct_prediction_log_settlement_idx on public.correct_prediction_log (settlement_id);

-- No grants to authenticated at all — read only through get_leaderboard
-- below (all-time reads never touch this table; weekly/monthly aggregate
-- it server-side inside that function).
grant select, insert, delete on public.correct_prediction_log to service_role;

-- ---------------------------------------------------------------------
-- confirm_pool_settlement: re-created (plpgsql functions are replaced
-- wholesale, not patched) with the same body as
-- 20260101000010_settlements.sql, plus: WON entries append to
-- correct_prediction_log and increment correct_predictions_count/
-- current_streak/best_streak; LOST entries reset current_streak to 0.
-- Guarded by the same existing idempotency check (confirmed_at is not
-- null -> early return), so a repeat call never double-counts.
-- ---------------------------------------------------------------------

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

  -- Phase 7: a LOST entry breaks the losing player's streak. VOID/REFUNDED
  -- entries never reach this function at all (produced by
  -- confirm_pool_refund instead) — correctly skipped, not counted as a
  -- break.
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

    -- Phase 7: literal correct-prediction count + streak, not points.
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

-- ---------------------------------------------------------------------
-- reverse_pool_settlement: re-created with the same body as
-- 20260101000011_reversal_and_reporting.sql, plus: undo the leaderboard
-- side effects of every WON entry being clawed back, so the immediate
-- re-settlement this function triggers (a fresh settlement row via
-- prepare_pool_settlement, later re-confirmed) doesn't double-count a
-- prediction that turns out to still be correct.
--
-- Streak rollback is a best-effort decrement-by-one (floored at 0), exact
-- only when no other pool has settled for that user between the original
-- confirmation and its reversal. Reversal is a same-day admin operation,
-- so that holds in the overwhelming common case; exact rollback would
-- need a full per-settlement streak-delta history, out of scope here.
-- best_streak is deliberately left untouched — a high-water mark isn't
-- worth this complexity to claw back.
-- ---------------------------------------------------------------------

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

    -- Phase 7: undo the correct-prediction count/streak/log this winner
    -- picked up when this (now-reversed) settlement first confirmed.
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

  -- Immediately re-settle with current fixture data, landing on
  -- READY_FOR_REVIEW with a fresh snapshot (spec §17.3).
  perform public.prepare_pool_settlement(p_pool_id);

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.reverse_pool_settlement(uuid, uuid, text, text) from public;
grant execute on function public.reverse_pool_settlement(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
-- get_leaderboard: 'global' or 'following' scope, 'all_time'/'weekly'/
-- 'monthly' range. All-time reads the denormalized counter directly;
-- weekly/monthly aggregate correct_prediction_log. Capped at 100 rows —
-- a ranking list is never meant to show the entire user base.
-- ---------------------------------------------------------------------

create or replace function public.get_leaderboard(p_scope text, p_range text, p_caller_id uuid)
returns table (
  user_id uuid, display_name text, username text, avatar_url text, correct_count bigint, rank bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if p_range = 'all_time' then
    return query
      select
        up.id,
        up.display_name,
        up.username,
        up.avatar_url,
        up.correct_predictions_count,
        rank() over (order by up.correct_predictions_count desc)
      from public.user_profiles up
      where up.is_active = true
        and (
          p_scope = 'global'
          or up.id = p_caller_id
          or up.id in (select f.followee_id from public.follows f where f.follower_id = p_caller_id)
        )
      order by up.correct_predictions_count desc
      limit 100;
  else
    return query
      select
        up.id,
        up.display_name,
        up.username,
        up.avatar_url,
        coalesce(counts.cnt, 0),
        rank() over (order by coalesce(counts.cnt, 0) desc)
      from public.user_profiles up
      left join (
        select cpl.user_id, count(*) as cnt
        from public.correct_prediction_log cpl
        where cpl.created_at >= case p_range
          when 'weekly' then date_trunc('week', now())
          when 'monthly' then date_trunc('month', now())
          else '-infinity'::timestamptz
        end
        group by cpl.user_id
      ) counts on counts.user_id = up.id
      where up.is_active = true
        and (
          p_scope = 'global'
          or up.id = p_caller_id
          or up.id in (select f.followee_id from public.follows f where f.follower_id = p_caller_id)
        )
      order by coalesce(counts.cnt, 0) desc
      limit 100;
  end if;
end;
$$;

revoke all on function public.get_leaderboard(text, text, uuid) from public;
grant execute on function public.get_leaderboard(text, text, uuid) to authenticated, service_role;
