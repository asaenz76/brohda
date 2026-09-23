-- Milestone R8 (docs/BROHDA_2_0_MILESTONE_MAP.md, Wallet Reservation Layer).
-- Additive only. Extends the existing, canonical wallet/ledger system —
-- wallet_balances / wallet_transactions / apply_wallet_transaction() — with
-- a reservation/hold primitive. No second wallet system, no monetary
-- Challenge/Position schema (R9's own concern). See
-- docs/architecture/wallet-reservation-layer.md for the full rationale.
--
-- Repository-truth-gather confirmed R0.5's findings still hold:
-- apply_wallet_transaction() is the ONE mutation point for wallet_balances
-- (SELECT ... FOR UPDATE, replay-safe idempotency-key lookup, debit rejects
-- when it would go negative); no reservation/hold/pending-commitment
-- concept exists anywhere in the wallet layer today; pool entry debits
-- immediately (no deferred/committed-but-undebited state); a pending
-- withdrawal request does NOT reserve funds today (confirmed: submitting
-- one only inserts a wallet_requests row — verified directly against
-- lib/actions/wallet-requests.ts — meaning a user could otherwise spend
-- the same balance in a paid pool before an admin approves the
-- withdrawal). This migration closes exactly that gap for withdrawals,
-- per this milestone's own §11 example, without touching pool economics.

-- =====================================================================
-- Balance semantics (§4): wallet_balances.balance already means TOTAL
-- OWNED balance (apply_wallet_transaction's own debit check is `balance -
-- amount >= 0` — a pure ownership check, never anything resembling
-- "spendable minus commitments"). That meaning is preserved EXACTLY
-- unchanged. `reserved_balance` is new, additive, defaults to 0 for every
-- existing row — so immediately after this migration, for every existing
-- wallet: total = old balance, reserved = 0, available = old balance,
-- identically. Available is a derived formula (balance - reserved_balance),
-- never its own stored column, so it can never itself drift out of sync.
-- =====================================================================
alter table public.wallet_balances
  add column reserved_balance bigint not null default 0 check (reserved_balance >= 0);

-- The one unconditional, schema-enforced version of "total balance >=
-- active reserved amount" (§29) — never relies on periodic reconciliation
-- to restore correctness. Every function in this migration that could
-- otherwise violate it (apply_wallet_transaction's own debit check, and
-- reverse_pool_settlement's dry-run pre-check, extended below) is written
-- to never attempt a write that would fail this constraint — it exists as
-- defense in depth, not as the primary enforcement mechanism.
alter table public.wallet_balances
  add constraint wallet_balances_reserved_not_exceeding_balance check (reserved_balance <= balance);

comment on column public.wallet_balances.reserved_balance is
  'Sum of this account''s currently ACTIVE wallet_reservations rows, maintained transactionally by reserve_funds()/release_reservation()/consume_reservation() (materialized total — see those functions'' own comments for why, and docs/architecture/wallet-reservation-layer.md). Available balance = balance - reserved_balance; there is no separate "available" column. Always 0 for the house account (reservations are a per-user concept; nothing in this codebase ever reserves against house).';

-- =====================================================================
-- The first-class reservation record (§6). One row per hold, full
-- lifecycle history preserved forever (terminal rows are never deleted or
-- overwritten into an unrecognizable state — §42).
-- =====================================================================
create type public.wallet_reservation_status as enum ('ACTIVE', 'RELEASED', 'CONSUMED');

-- Deliberately just the one purpose R8 itself actually wires up (§34's own
-- explicit instruction: do NOT hard-code a future R9 purpose like
-- CALL_BS_MONEY here — R9 has not been implemented). A future milestone
-- adds its own value via its own additive migration, exactly like R6/R7
-- each added their own new notifications.* FK column rather than
-- speculatively pre-building a generic reference scheme.
create type public.wallet_reservation_purpose as enum ('withdrawal_request');

create table public.wallet_reservations (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.user_profiles (id) on delete cascade,
  amount                   bigint not null check (amount > 0),
  status                   public.wallet_reservation_status not null default 'ACTIVE',
  purpose                  public.wallet_reservation_purpose not null,

  -- Durable reservation<->ledger correlation once consumed (§44) — proves
  -- "ACTIVE reservation X -> consumed -> debit transaction Y" without
  -- relying on logs. Real, non-cascading FK: wallet_transactions rows are
  -- permanent (append-only, forbid_audit_log_mutation trigger).
  consumed_transaction_id  uuid references public.wallet_transactions (id),

  idempotency_key          text not null unique,

  released_at              timestamptz,
  consumed_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint wallet_reservations_released_at_shape check ((status = 'RELEASED') = (released_at is not null)),
  constraint wallet_reservations_consumed_at_shape check ((status = 'CONSUMED') = (consumed_at is not null)),
  constraint wallet_reservations_consumed_transaction_shape check ((status = 'CONSUMED') = (consumed_transaction_id is not null))
);

create index idx_wallet_reservations_user on public.wallet_reservations (user_id, created_at desc);
create index idx_wallet_reservations_active on public.wallet_reservations (user_id) where status = 'ACTIVE';

alter table public.wallet_reservations enable row level security;

-- Same shape as wallet_balances' own two SELECT policies (§33, §41): own
-- rows, or every row for a super_admin. No INSERT/UPDATE/DELETE grant to
-- authenticated at all — every mutation goes through the three RPCs below
-- via the service role.
create policy "select_own_wallet_reservations" on public.wallet_reservations for select to authenticated
  using (user_id = auth.uid());
create policy "select_all_wallet_reservations_as_admin" on public.wallet_reservations for select to authenticated
  using (public.is_super_admin(auth.uid()));

grant select on public.wallet_reservations to authenticated;
grant select, insert, update on public.wallet_reservations to service_role;

-- Correlates a withdrawal request to the reservation that holds its funds
-- while pending (§11's own worked example). Null for a deposit request —
-- deposits never reserve anything (§13).
alter table public.wallet_requests add column reservation_id uuid references public.wallet_reservations (id);

comment on column public.wallet_requests.reservation_id is
  'The ACTIVE (while pending) or terminal (once approved/rejected) reservation holding this withdrawal request''s amount. Always null for a deposit request. Set at submission time, before the wallet_requests row itself is inserted (see submitWalletRequestAction) — reserve first, then record the request, so a request never exists without its funds genuinely held.';

-- =====================================================================
-- apply_wallet_transaction(): the ONE-LINE strengthening (§27) that makes
-- every existing debit caller reservation-aware for free, with no
-- per-caller patching. Old check: `v_new_balance < 0` (raw ownership
-- floor). New check: `v_new_balance < v_balance_row.reserved_balance`
-- (available floor) — a strict superset of the old one: reserved_balance
-- is always 0 until something actually reserves against this account (and
-- always 0 forever for the house account, which nothing in this codebase
-- ever reserves against), so this is byte-for-byte behaviorally identical
-- to the old check for every existing caller today, and only starts
-- mattering the moment a real ACTIVE reservation exists. The raised
-- exception message is deliberately left as the exact string
-- 'insufficient_balance', unchanged, since every existing caller
-- (lib/actions/entries.ts, wallet.ts, wallet-requests.ts) matches on that
-- exact substring for its own user-facing copy.
--
-- No account_type or wallet_transaction_type branching was added: every
-- caller of a debit already respects available for free. The one caller
-- that must legitimately claw back an erroneous credit regardless of an
-- unrelated hold — reverse_pool_settlement's settlement_reversal_debit
-- path — gets its OWN explicit, documented pre-check extended below
-- (§12: "if some system-authoritative debit can legitimately do so,
-- that is a financial invariant conflict and must be resolved explicitly
-- ... do not hide it") rather than a silent carve-out inside this
-- function — reversal never even attempts a write that would violate
-- wallet_balances_reserved_not_exceeding_balance; it fails safe to
-- REVERSAL_FAILED_MANUAL_REVIEW instead, exactly like its own pre-existing
-- "can't absorb the clawback" case.
create or replace function public.apply_wallet_transaction(
  p_account_type wallet_account_type,
  p_user_id uuid,
  p_type wallet_transaction_type,
  p_direction wallet_direction,
  p_amount bigint,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_pool_id uuid default null,
  p_entry_id uuid default null,
  p_settlement_id uuid default null,
  p_destination text default null
)
returns wallet_transactions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing public.wallet_transactions;
  v_balance_row public.wallet_balances;
  v_new_balance bigint;
  v_result public.wallet_transactions;
  v_pool_question text;
  v_fixture_label text;
  v_competition_name text;
  v_option_label text;
begin
  select * into v_existing
  from public.wallet_transactions
  where idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_account_type = 'user' then
    select * into v_balance_row
    from public.wallet_balances
    where user_id = p_user_id and account_type = 'user'
    for update;
  else
    select * into v_balance_row
    from public.wallet_balances
    where account_type = 'house'
    for update;
  end if;

  if not found then
    raise exception 'wallet balance row not found';
  end if;

  if p_direction = 'credit' then
    v_new_balance := v_balance_row.balance + p_amount;
  else
    v_new_balance := v_balance_row.balance - p_amount;
    if v_new_balance < v_balance_row.reserved_balance then
      raise exception 'insufficient_balance';
    end if;
  end if;

  if p_pool_id is not null then
    select coalesce(p.title, p.question),
           case when f.id is not null then f.home_team_name || ' vs ' || f.away_team_name else null end,
           f.competition_name
      into v_pool_question, v_fixture_label, v_competition_name
    from public.pools p
    left join public.fixtures f on f.id = p.fixture_id
    where p.id = p_pool_id;
  end if;

  if p_entry_id is not null then
    select po.label into v_option_label
    from public.entries e
    join public.pool_options po on po.id = e.option_id
    where e.id = p_entry_id;
  end if;

  insert into public.wallet_transactions (
    account_type, user_id, type, direction, amount,
    balance_before, balance_after, currency,
    pool_id, entry_id, settlement_id, admin_id, reason, idempotency_key,
    pool_question, fixture_label, competition_name, option_label, destination
  ) values (
    p_account_type, p_user_id, p_type, p_direction, p_amount,
    v_balance_row.balance, v_new_balance, v_balance_row.currency,
    p_pool_id, p_entry_id, p_settlement_id, p_admin_id, p_reason, p_idempotency_key,
    v_pool_question, v_fixture_label, v_competition_name, v_option_label, p_destination
  ) returning * into v_result;

  update public.wallet_balances
  set balance = v_new_balance, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$function$;

-- Privilege boundary restated for the new function body (same signature —
-- CREATE OR REPLACE above did not change it, this line is defense in depth
-- matching every prior migration's own convention of restating the grant
-- alongside any redefinition).
revoke all on function public.apply_wallet_transaction(wallet_account_type, uuid, wallet_transaction_type, wallet_direction, bigint, uuid, text, text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.apply_wallet_transaction(wallet_account_type, uuid, wallet_transaction_type, wallet_direction, bigint, uuid, text, text, uuid, uuid, uuid, text) to service_role;

-- =====================================================================
-- reserve_funds(): §8. Atomically verifies available >= amount and
-- creates the hold. Idempotency mirrors apply_wallet_transaction's own
-- exact pattern (look up by idempotency_key first, replay if found) —
-- "use the repository's existing idempotency conventions" (§18), not a
-- weaker reservation-specific one.
-- =====================================================================
create or replace function public.reserve_funds(
  p_user_id uuid,
  p_amount bigint,
  p_purpose wallet_reservation_purpose,
  p_idempotency_key text
)
returns wallet_reservations
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing public.wallet_reservations;
  v_balance_row public.wallet_balances;
  v_available bigint;
  v_result public.wallet_reservations;
begin
  select * into v_existing from public.wallet_reservations where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  select * into v_balance_row from public.wallet_balances
    where user_id = p_user_id and account_type = 'user' for update;
  if not found then
    raise exception 'wallet balance row not found';
  end if;

  v_available := v_balance_row.balance - v_balance_row.reserved_balance;
  if p_amount > v_available then
    raise exception 'insufficient_available_balance';
  end if;

  insert into public.wallet_reservations (user_id, amount, purpose, idempotency_key)
  values (p_user_id, p_amount, p_purpose, p_idempotency_key)
  returning * into v_result;

  update public.wallet_balances
  set reserved_balance = reserved_balance + p_amount, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$$;

revoke all on function public.reserve_funds(uuid, bigint, wallet_reservation_purpose, text) from public, anon, authenticated;
grant execute on function public.reserve_funds(uuid, bigint, wallet_reservation_purpose, text) to service_role;

-- =====================================================================
-- release_reservation() / consume_reservation(): §15-16, §23. Both use
-- the (row, outcome) composite pattern — not R6/R7's plain-exception
-- style — because both have a genuine "the row may already be in its
-- other terminal state" retry case that must return current state rather
-- than throw, distinguishing "already what you asked for" from "the
-- OTHER, mutually-exclusive terminal state already won" (§23) rather than
-- collapsing both into one generic error.
-- =====================================================================
create type public.release_reservation_result as (
  reservation wallet_reservations,
  outcome text
);

create or replace function public.release_reservation(p_reservation_id uuid)
returns release_reservation_result
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reservation public.wallet_reservations;
  v_result public.wallet_reservations;
begin
  select * into v_reservation from public.wallet_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'reservation_not_found';
  end if;

  if v_reservation.status = 'RELEASED' then
    return (v_reservation, 'already_released')::release_reservation_result;
  end if;
  if v_reservation.status = 'CONSUMED' then
    return (v_reservation, 'already_consumed')::release_reservation_result;
  end if;

  -- ACTIVE -> RELEASED. Restores availability by removing this hold from
  -- reserved_balance — never touches `balance` itself (§15: release must
  -- NOT increase total owned balance; this is not a credit).
  update public.wallet_balances
  set reserved_balance = reserved_balance - v_reservation.amount, updated_at = now()
  where user_id = v_reservation.user_id and account_type = 'user';

  update public.wallet_reservations
  set status = 'RELEASED', released_at = now(), updated_at = now()
  where id = v_reservation.id
  returning * into v_result;

  return (v_result, 'released')::release_reservation_result;
end;
$$;

revoke all on function public.release_reservation(uuid) from public, anon, authenticated;
grant execute on function public.release_reservation(uuid) to service_role;

create type public.consume_reservation_result as (
  reservation wallet_reservations,
  wallet_transaction wallet_transactions,
  outcome text
);

-- Consumption (§16, §24): converts the hold into a real debit, atomically,
-- with no moment where the funds are simultaneously available AND
-- reserved AND undebited. The reserved_balance decrement happens BEFORE
-- calling apply_wallet_transaction, in the same transaction, on the same
-- already-locked wallet_balances row — so by the time
-- apply_wallet_transaction computes its own available check, THIS
-- reservation's amount is no longer counted against it (it is, after all,
-- about to become a real debit for that exact amount), while any OTHER
-- still-ACTIVE reservation on the same account correctly remains
-- protected. This is what makes §24's worked example hold: consuming an
-- 80 reservation and an unrelated 20 debit can both legitimately succeed
-- from the same 100 total, but an unrelated 30 debit cannot.
create or replace function public.consume_reservation(
  p_reservation_id uuid,
  p_wallet_txn_type wallet_transaction_type,
  p_wallet_txn_admin_id uuid,
  p_wallet_txn_reason text,
  p_wallet_txn_idempotency_key text,
  p_wallet_txn_destination text default null
)
returns consume_reservation_result
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_reservation public.wallet_reservations;
  v_result public.wallet_reservations;
  v_txn public.wallet_transactions;
begin
  select * into v_reservation from public.wallet_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'reservation_not_found';
  end if;

  if v_reservation.status = 'CONSUMED' then
    select * into v_txn from public.wallet_transactions where id = v_reservation.consumed_transaction_id;
    return (v_reservation, v_txn, 'already_consumed')::consume_reservation_result;
  end if;
  if v_reservation.status = 'RELEASED' then
    return (v_reservation, null, 'already_released')::consume_reservation_result;
  end if;

  update public.wallet_balances
  set reserved_balance = reserved_balance - v_reservation.amount, updated_at = now()
  where user_id = v_reservation.user_id and account_type = 'user';

  v_txn := public.apply_wallet_transaction(
    'user'::public.wallet_account_type,
    v_reservation.user_id,
    p_wallet_txn_type,
    'debit'::public.wallet_direction,
    v_reservation.amount,
    p_wallet_txn_admin_id,
    p_wallet_txn_reason,
    p_wallet_txn_idempotency_key,
    null, null, null,
    p_wallet_txn_destination
  );

  update public.wallet_reservations
  set status = 'CONSUMED', consumed_at = now(), consumed_transaction_id = v_txn.id, updated_at = now()
  where id = v_reservation.id
  returning * into v_result;

  return (v_result, v_txn, 'consumed')::consume_reservation_result;
end;
$$;

revoke all on function public.consume_reservation(uuid, wallet_transaction_type, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.consume_reservation(uuid, wallet_transaction_type, uuid, text, text, text) to service_role;

-- =====================================================================
-- reverse_pool_settlement(): the one documented, explicit extension to an
-- existing R1-era financial function (§12, §58 — audited every caller
-- first: lib/actions/reversal.ts, requireSuperAdmin()-gated, the only
-- caller). Its dry-run pre-check already refuses the ENTIRE reversal
-- (zero wallet writes, REVERSAL_FAILED_MANUAL_REVIEW) if any winner's
-- current balance can't absorb the clawback down to zero; it now ALSO
-- refuses if the clawback would push a winner's balance below their own
-- reserved_balance, using the exact same fail-safe-to-manual-review
-- mechanism, not a silent exception. This is what lets
-- wallet_balances_reserved_not_exceeding_balance remain a truly
-- UNCONDITIONAL invariant with no carve-out anywhere else in the system —
-- reversal never attempts a write that would violate it.
-- Behaviorally identical to before this migration for every account with
-- reserved_balance = 0 (every account, until a reservation is ever made).
-- =====================================================================
create or replace function public.reverse_pool_settlement(p_pool_id uuid, p_admin_id uuid, p_reason text, p_idempotency_key text)
returns pools
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pool public.pools;
  v_settlement public.settlements;
  v_payout record;
  v_balance bigint;
  v_reserved bigint;
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
  -- clawback WITHOUT dipping into their own reserved_balance (Milestone
  -- R8 addition — see this function's own header comment above). Pure
  -- reads/locks — nothing written yet.
  for v_payout in
    select sp.entry_id, sp.amount, e.user_id
    from public.settlement_payouts sp
    join public.entries e on e.id = sp.entry_id
    where sp.settlement_id = v_settlement.id
  loop
    select balance, reserved_balance into v_balance, v_reserved
      from public.wallet_balances where user_id = v_payout.user_id and account_type = 'user'
      for update;

    v_report := v_report || jsonb_build_object(
      'userId', v_payout.user_id,
      'creditedAmount', v_payout.amount,
      'currentBalance', v_balance,
      'reservedBalance', v_reserved,
      'shortfall', greatest(v_payout.amount - (v_balance - v_reserved), 0)
    );

    if v_balance - v_payout.amount < v_reserved then
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
$function$;

revoke all on function public.reverse_pool_settlement(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reverse_pool_settlement(uuid, uuid, text, text) to service_role;
