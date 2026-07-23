-- Phase 6: settlement reversal, job-run tracking (spec §17, §18, §23)

alter table public.settlements
  add column reversed_at timestamptz,
  add column reversed_by_admin_id uuid references public.user_profiles (id),
  add column reversal_reason text,
  -- Populated only when a reversal attempt is blocked (spec §17.4): every
  -- affected winner's credited amount, current balance, and shortfall.
  -- Display names are joined from user_profiles at render time, not
  -- denormalized here.
  add column reversal_shortfall_report jsonb;

-- Spec §18's background_jobs table. Nothing in Phases 1-5 persisted cron
-- run history anywhere — each route just returned its result and it was
-- lost. Same RLS shape as provider_request_log (admin-only select).
create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null check (status in ('success', 'error')),
  result jsonb,
  error text,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  duration_ms integer not null
);

create index idx_background_jobs_name_finished on public.background_jobs (job_name, finished_at desc);

alter table public.background_jobs enable row level security;

create policy "admins_read_background_jobs"
on public.background_jobs for select
to authenticated
using (public.is_super_admin(auth.uid()));

grant select on public.background_jobs to authenticated;
grant select, insert on public.background_jobs to service_role;

-- ---------------------------------------------------------------------
-- prepare_pool_settlement: relax the status guard to also accept
-- SETTLEMENT_REVERSED (Phase 6's re-settlement step, called internally by
-- reverse_pool_settlement below). Everything else is identical to the
-- Phase 5 version — it already reads pools.snapshot_version fresh and
-- inserts the new settlement row there, so a prior snapshot_version bump
-- is all re-settlement needs.
-- ---------------------------------------------------------------------

create or replace function public.prepare_pool_settlement(p_pool_id uuid)
returns public.settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_fixture public.fixtures;
  v_existing public.settlements;
  v_winning_option_id uuid;
  v_reason public.winning_option_reason;
  v_requires_manual boolean := false;
  v_gross_pool bigint;
  v_total_valid_entries integer;
  v_house_fee_amount bigint := 0;
  v_net_prize_pool bigint := 0;
  v_winning_entry_count integer;
  v_payout_per_entry bigint := 0;
  v_rounding_remainder bigint := 0;
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

  if v_pool.status not in ('AWAITING_RESULT', 'SETTLEMENT_REVERSED') then
    raise exception 'pool_not_awaiting_result';
  end if;

  select * into v_fixture from public.fixtures where id = v_pool.fixture_id;
  if not found then
    raise exception 'fixture_not_found';
  end if;

  -- Winning-side determination (no precomputed winner columns exist on
  -- fixtures — derived here from the score columns Phase 3 already syncs).
  if v_pool.pool_type = 'WHO_WILL_ADVANCE' then
    if v_fixture.penalty_home_score is not null and v_fixture.penalty_away_score is not null
       and v_fixture.penalty_home_score <> v_fixture.penalty_away_score then
      select id into v_winning_option_id from public.pool_options
        where pool_id = p_pool_id and external_team_id =
          case when v_fixture.penalty_home_score > v_fixture.penalty_away_score
            then v_fixture.home_team_external_id else v_fixture.away_team_external_id end;
      v_reason := 'ADVANCED_ON_PENALTIES';
    elsif v_fixture.home_score is not null and v_fixture.away_score is not null
       and v_fixture.home_score <> v_fixture.away_score then
      select id into v_winning_option_id from public.pool_options
        where pool_id = p_pool_id and external_team_id =
          case when v_fixture.home_score > v_fixture.away_score
            then v_fixture.home_team_external_id else v_fixture.away_team_external_id end;
      v_reason := case
        when v_fixture.extra_time_home_score is not null or v_fixture.extra_time_away_score is not null
        then 'ADVANCED_IN_EXTRA_TIME'::public.winning_option_reason
        else 'ADVANCED_IN_REGULATION'::public.winning_option_reason
      end;
    else
      v_requires_manual := true;
    end if;
  else -- REGULATION_RESULT
    if v_fixture.regulation_home_score is not null and v_fixture.regulation_away_score is not null then
      if v_fixture.regulation_home_score > v_fixture.regulation_away_score then
        select id into v_winning_option_id from public.pool_options
          where pool_id = p_pool_id and external_team_id = v_fixture.home_team_external_id;
        v_reason := 'REGULATION_HOME_WIN';
      elsif v_fixture.regulation_home_score < v_fixture.regulation_away_score then
        select id into v_winning_option_id from public.pool_options
          where pool_id = p_pool_id and external_team_id = v_fixture.away_team_external_id;
        v_reason := 'REGULATION_AWAY_WIN';
      else
        select id into v_winning_option_id from public.pool_options
          where pool_id = p_pool_id and external_team_id is null;
        v_reason := 'REGULATION_DRAW';
      end if;
    else
      v_requires_manual := true;
    end if;
  end if;

  if v_requires_manual or v_winning_option_id is null then
    v_requires_manual := true;
    v_winning_option_id := null;
    v_reason := null;
  end if;

  select coalesce(sum(entry_count), 0), coalesce(sum(total_entry_amount), 0)
    into v_total_valid_entries, v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

  if v_winning_option_id is not null then
    select entry_count into v_winning_entry_count
      from public.pool_options where id = v_winning_option_id;

    if v_winning_entry_count = 0 then
      v_outcome := 'NO_WINNING_ENTRIES_REFUND';
    elsif v_total_valid_entries > 0 and v_winning_entry_count = v_total_valid_entries then
      v_outcome := 'ALL_ENTRIES_WINNING_REFUND';
    end if;
  end if;

  if v_outcome = 'NORMAL' then
    v_house_fee_amount := (v_gross_pool * v_pool.house_fee_bps) / 10000;
    v_net_prize_pool := v_gross_pool - v_house_fee_amount;
    if v_winning_entry_count is not null and v_winning_entry_count > 0 then
      v_payout_per_entry := v_net_prize_pool / v_winning_entry_count;
      v_rounding_remainder := v_net_prize_pool - (v_payout_per_entry * v_winning_entry_count);
    end if;
  end if;

  insert into public.settlements (
    pool_id, grading_version, provider_status,
    regulation_home_score, regulation_away_score,
    extra_time_home_score, extra_time_away_score,
    penalty_home_score, penalty_away_score,
    winning_option_id, winning_option_reason, requires_manual_verification,
    gross_pool, house_fee_bps, house_fee_amount, net_prize_pool,
    winning_entry_count, payout_per_entry, rounding_remainder,
    raw_provider_snapshot, outcome
  ) values (
    p_pool_id, v_pool.snapshot_version, v_fixture.internal_status::text,
    v_fixture.regulation_home_score, v_fixture.regulation_away_score,
    v_fixture.extra_time_home_score, v_fixture.extra_time_away_score,
    v_fixture.penalty_home_score, v_fixture.penalty_away_score,
    v_winning_option_id, v_reason, v_requires_manual,
    v_gross_pool, v_pool.house_fee_bps, v_house_fee_amount, v_net_prize_pool,
    v_winning_entry_count, v_payout_per_entry, v_rounding_remainder,
    v_fixture.provider_payload, v_outcome
  ) returning * into v_result;

  update public.pools set status = 'READY_FOR_REVIEW' where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.prepare_pool_settlement(uuid) from public;
grant execute on function public.prepare_pool_settlement(uuid) to service_role;

-- ---------------------------------------------------------------------
-- reverse_pool_settlement: spec §17's dry-run-then-execute-or-block
-- workflow, as a single admin-triggered call. Callable from SETTLED
-- (first request) or REVERSAL_FAILED_MANUAL_REVIEW (retry after the admin
-- resolves shortfalls out of band). Idempotent: reversing an
-- already-reversed settlement is a no-op ("at most once").
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
-- abort_pool_reversal: REVERSAL_FAILED_MANUAL_REVIEW -> SETTLED, no
-- financial effect (spec §17.4's "aborts" path).
-- ---------------------------------------------------------------------

create or replace function public.abort_pool_reversal(p_pool_id uuid)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
begin
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

revoke all on function public.abort_pool_reversal(uuid) from public;
grant execute on function public.abort_pool_reversal(uuid) to service_role;
