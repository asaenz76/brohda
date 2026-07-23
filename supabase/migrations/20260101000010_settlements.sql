-- Phase 5: settlement, anomaly handling, notifications (spec §16-§20, X.7)

create type public.winning_option_reason as enum (
  'ADVANCED_IN_REGULATION',
  'ADVANCED_IN_EXTRA_TIME',
  'ADVANCED_ON_PENALTIES',
  'REGULATION_HOME_WIN',
  'REGULATION_DRAW',
  'REGULATION_AWAY_WIN',
  'MANUAL_ADMIN_OVERRIDE'
);

-- X.7.1's four named anomaly reasons, plus MATCH_AWARDED/MATCH_STATUS_UNKNOWN
-- (spec §16.4 lists AWARDED/UNKNOWN fixtures alongside the anomaly statuses
-- as "never enter normal settlement" — no same-day wait for either, since
-- neither implies a match that might still resume), plus the three §16.8
-- outcomes sharing the same refund machinery.
create type public.pool_void_reason as enum (
  'MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY',
  'MATCH_SUSPENDED_NOT_COMPLETED_SAME_DAY',
  'MATCH_ABANDONED',
  'MATCH_CANCELLED',
  'MATCH_AWARDED',
  'MATCH_STATUS_UNKNOWN',
  'MINIMUM_ENTRIES_NOT_REACHED',
  'NO_WINNING_ENTRIES',
  'ALL_ENTRIES_WINNING'
);

alter table public.pools add column void_reason public.pool_void_reason;

-- wallet_transactions.pool_id/entry_id/settlement_id deliberately stay plain
-- uuid columns with no FK — same reasoning as audit_logs.entity_id (no FK
-- either): wallet_transactions is permanently append-only, so a hard FK
-- from it would make any pool/entry/settlement it ever references
-- permanently undeletable too. That's fine in production (financial history
-- should outlive the entity), but it silently breaks integration-test
-- cleanup, which was the first thing that surfaced it — confirmed by
-- actually adding the FKs, hitting exactly that failure, and reverting.

-- One row per grading attempt (spec §16.1/§16.5). `outcome` distinguishes a
-- normal settlement from a proposed refund (§16.8's no-winner/all-winner —
-- shown to the admin, not silently executed).
create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id),
  grading_version integer not null,
  provider_status text not null,
  regulation_home_score integer,
  regulation_away_score integer,
  extra_time_home_score integer,
  extra_time_away_score integer,
  penalty_home_score integer,
  penalty_away_score integer,
  winning_option_id uuid references public.pool_options (id),
  winning_option_reason public.winning_option_reason,
  requires_manual_verification boolean not null default false,
  gross_pool bigint not null default 0,
  house_fee_bps integer not null default 0,
  house_fee_amount bigint not null default 0,
  net_prize_pool bigint not null default 0,
  winning_entry_count integer,
  payout_per_entry bigint not null default 0,
  rounding_remainder bigint not null default 0,
  raw_provider_snapshot jsonb,
  outcome text not null default 'NORMAL'
    check (outcome in ('NORMAL', 'NO_WINNING_ENTRIES_REFUND', 'ALL_ENTRIES_WINNING_REFUND')),
  confirmed_by_admin_id uuid references public.user_profiles (id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pool_id, grading_version)
);

create index idx_settlements_pool on public.settlements (pool_id);

create table public.settlement_payouts (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements (id),
  entry_id uuid not null references public.entries (id),
  amount bigint not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (settlement_id, entry_id)
);

-- Spec §20. title/body are stored as final display text — copy is built
-- once in lib/pools/notices.ts (app layer) and inserted after the RPC call
-- below returns, not duplicated in SQL.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles (id),
  type text not null,
  title text not null,
  body text not null,
  pool_id uuid references public.pools (id),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_notifications_user on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- prepare_pool_settlement: AWAITING_RESULT -> READY_FOR_REVIEW.
-- Determines the winning side (or flags manual verification), computes
-- gross/fee/net/payout/remainder, detects no-winner/all-winner. Idempotent:
-- a repeat call at the same snapshot_version returns the existing row.
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

  if v_pool.status <> 'AWAITING_RESULT' then
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
-- confirm_pool_settlement: READY_FOR_REVIEW -> SETTLED (spec §16.7).
-- Rejects a stale snapshot_version and rejects outcome != 'NORMAL' (those
-- go through confirm_pool_refund below). Notifications are NOT inserted
-- here — the caller builds copy via lib/pools/notices.ts and inserts them
-- after this returns, keeping presentation text out of SQL.
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
-- confirm_pool_refund: shared void/refund machinery for both fully
-- automatic reasons (min-entries, X.7 anomalies — p_admin_id null, called
-- by the cron) and admin-confirmed reasons (no-winner/all-winner, from the
-- READY_FOR_REVIEW screen — p_grading_version supplied for the stale check).
-- Idempotent: a pool already in a terminal status is a no-op.
-- ---------------------------------------------------------------------

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

  v_new_status := case when p_void_reason = 'MINIMUM_ENTRIES_NOT_REACHED'
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

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table public.settlements enable row level security;
alter table public.settlement_payouts enable row level security;
alter table public.notifications enable row level security;

-- Final results are shared social info, same visibility as the pool itself.
create policy "settlements_visible_with_pool"
on public.settlements for select
to authenticated
using (
  exists (
    select 1 from public.pools p
    where p.id = settlements.pool_id
      and (p.status != 'DRAFT' or public.is_super_admin(auth.uid()))
  )
);

grant select on public.settlements to authenticated;
grant select, insert, update, delete on public.settlements to service_role;

-- Per-entry payout amounts are private to the entry's owner.
create policy "settlement_payouts_owner_or_admin"
on public.settlement_payouts for select
to authenticated
using (
  exists (
    select 1 from public.entries e
    where e.id = settlement_payouts.entry_id
      and (e.user_id = auth.uid() or public.is_super_admin(auth.uid()))
  )
);

grant select on public.settlement_payouts to authenticated;
grant select, insert, update, delete on public.settlement_payouts to service_role;

create policy "notifications_own_only"
on public.notifications for select
to authenticated
using (user_id = auth.uid());

grant select on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications to service_role;
