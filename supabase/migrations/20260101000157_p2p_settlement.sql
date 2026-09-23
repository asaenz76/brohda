-- Milestone R10 (docs/BROHDA_2_0_MILESTONE_MAP.md, P2P Settlement).
-- Additive only. Takes a COMMITTED Monetary Position (R9) whose exact
-- Market has an authoritative final result and settles it exactly once —
-- reservations resolved, loser stake debited, winner credited, Brohda fee
-- applied if configured, durable settlement record created, Position made
-- terminal. See docs/architecture/p2p-settlement.md for full rationale.
--
-- Repository-truth-gather confirmed: no existing fee mechanism applies to
-- P2P (pools.house_fee_bps is a per-pool column belonging entirely to the
-- separate legacy pools/entries/settlements product); Market grading
-- (lib/predictions/grading.ts's runGradingJob, via computeSportsMarketOutcome)
-- is genuinely one-shot and immutable per Prediction — no regrading/
-- correction path exists anywhere in this codebase today, which is exactly
-- the guarantee this migration's own settlement transaction relies on;
-- close_own_account() already refuses to close any account with a nonzero
-- wallet_balances.balance, which structurally includes any account with an
-- ACTIVE reservation of ANY purpose (reserved_balance <= balance is a
-- schema-enforced invariant) — so a user with a still-COMMITTED Position
-- already cannot close their account today, with zero new code required.
--
-- The P2P fee itself is a genuine, explicit product decision (not a
-- guess): the product owner decided directly in this session that Brohda
-- takes NO P2P fee today, but the configurable infrastructure for one must
-- exist so it can be turned on later without a schema change — hence
-- platform_settings.p2p_fee_bps (default 0) below, fully wired through
-- real settlement math, snapshotted onto each Position at ACCEPTANCE time
-- (never re-read live at settlement) so a later fee-rate change can never
-- alter an already-committed Position's economics (§62).

-- =====================================================================
-- Two new wallet_transaction_type values for the two USER-facing sides of
-- a P2P settlement (§29-31) — reusing pool_payout_credit/pool_refund_credit
-- here would misrepresent provenance (a P2P win is not a pool payout).
-- The HOUSE side deliberately reuses the existing, already-generic
-- 'house_fee_credit' value rather than adding a third new one: its own
-- name already describes "a fee credited to the house" with no pool-
-- specific coupling in its actual usage (lib/wallet/transaction-copy.ts's
-- label is the pool-agnostic "Platform fee collected"; lib/reports/
-- fetch.ts's getHouseRevenue() sums it purely by type+amount, with no
-- assumption that pool_id is set) — reusing it here unifies platform-wide
-- fee reporting rather than fragmenting it across a redundant new value.
-- =====================================================================
alter type public.wallet_transaction_type add value 'p2p_position_win';
alter type public.wallet_transaction_type add value 'p2p_position_loss';

-- =====================================================================
-- The configurable P2P fee. Off (0) by default per the explicit product
-- decision above. 0-10000 basis points, matching pools.house_fee_bps's
-- own established range convention exactly.
-- =====================================================================
alter table public.platform_settings
  add column p2p_fee_bps integer not null default 0 check (p2p_fee_bps >= 0 and p2p_fee_bps <= 10000);

comment on column public.platform_settings.p2p_fee_bps is
  'Configurable P2P settlement fee in basis points (0-10000 = 0%-100%), applied to the LOSING stake (equivalently the winner''s gross profit, since R9''s Position is equal-stake-only) when a monetary Position settles with a winner — never applied on VOID. Defaults to 0: Brohda takes no P2P fee today. Read live only inside accept_monetary_proposal() (R9), which snapshots the current value onto the new Position''s own fee_bps column at the moment of commitment — settle_monetary_position() (R10) always uses that immutable per-Position snapshot, never this live column, so changing this value can never alter the economics of an already-committed Position (§62).';

-- =====================================================================
-- monetary_positions gets exactly the fields R10 needs (§40-41) — no
-- speculative dispute/arbitration vocabulary, matching the same
-- "add the column when the milestone that needs it arrives" discipline
-- R9 itself followed for R8's own purpose enum.
-- =====================================================================
alter table public.monetary_positions
  add column fee_bps integer not null default 0 check (fee_bps >= 0 and fee_bps <= 10000);

comment on column public.monetary_positions.fee_bps is
  'The P2P fee rate (basis points) in effect at the moment this Position was committed — captured once, at INSERT time inside accept_monetary_proposal(), from the then-current platform_settings.p2p_fee_bps. Immutable for the life of this Position. Existing pre-R10 Position rows (created before this column existed) are backfilled to 0 by this ALTER TABLE''s own default, which correctly reflects that no fee concept existed when they were created.';

alter table public.monetary_positions
  add column settlement_status text not null default 'COMMITTED'
    check (settlement_status in ('COMMITTED', 'SETTLED', 'VOIDED')),
  add column settled_at timestamptz,
  add column settlement_id uuid; -- FK added below, once monetary_position_settlements exists (same reasoning as R9's own proposal->position forward FK: an inline FK cannot reference a table that doesn't exist yet, regardless of DEFERRABLE).

alter table public.monetary_positions
  add constraint monetary_positions_settled_at_shape
    check ((settlement_status = 'COMMITTED') = (settled_at is null)),
  add constraint monetary_positions_settlement_id_shape
    check ((settlement_status = 'COMMITTED') = (settlement_id is null));

comment on column public.monetary_positions.settlement_status is
  'COMMITTED (default, R9''s own terminal state) -> SETTLED (a winner was paid) or VOIDED (both reservations released, no transfer). Deliberately minimal — no dispute/arbitration/pending-review status exists here; a settlement ATTEMPT that cannot safely proceed (Market not yet graded, or a detected financial invariant violation) leaves this column untouched at COMMITTED rather than inventing a third terminal-ish value (§38, §41) — see settle_monetary_position()''s own outcome values (not_eligible / invariant_violation) and lib/monetary/reconciliation.ts for how such a case becomes observable instead.';

-- =====================================================================
-- monetary_position_settlements (§19): the first-class, append-only,
-- fully immutable settlement audit record. Every field named in §19's own
-- "must be possible to reconstruct" list is present. proposer_user_id/
-- recipient_user_id are copied from the Position (always non-null, for
-- both WIN and VOID) specifically so RLS can check participancy uniformly
-- without a cross-table join — winner_user_id/loser_user_id are null for
-- VOID and exist purely for economic-outcome semantics, not privacy.
-- =====================================================================
create table public.monetary_position_settlements (
  id                              uuid primary key default gen_random_uuid(),
  position_id                     uuid not null unique references public.monetary_positions (id),
  market_id                       uuid not null, -- soft reference, matching monetary_positions.market_id/predictions.market_id/challenges.market_id throughout this codebase.

  proposer_user_id                uuid not null references public.user_profiles (id),
  recipient_user_id               uuid not null references public.user_profiles (id),

  outcome                         text not null check (outcome in ('PROPOSER_WINS', 'RECIPIENT_WINS', 'VOID')),
  winner_user_id                  uuid references public.user_profiles (id),
  loser_user_id                   uuid references public.user_profiles (id),

  stake                           bigint not null check (stake > 0),
  fee_bps                         integer not null check (fee_bps >= 0 and fee_bps <= 10000),
  fee_amount                      bigint not null default 0 check (fee_amount >= 0),
  winner_credit_amount            bigint not null default 0 check (winner_credit_amount >= 0),

  -- §20: the exact authoritative result this settlement used, preserved
  -- forever regardless of anything that happens to the Market/fixture
  -- afterward. market_result mirrors lib/predictions/types.ts's own
  -- PredictionOutcome-or-VOID vocabulary; the two per-participant fields
  -- are each graded Prediction's own already-computed result (§23: used
  -- as the Market-truth read path itself, not a separate participant
  -- claim — see settle_monetary_position()'s own comment for why reading
  -- these does not mean "settling from Prediction result alone").
  market_result                   text not null check (market_result in ('YES', 'NO', 'VOID')),
  proposer_prediction_result      text not null check (proposer_prediction_result in ('CORRECT', 'INCORRECT', 'VOID')),
  recipient_prediction_result     text not null check (recipient_prediction_result in ('CORRECT', 'INCORRECT', 'VOID')),

  proposer_reservation_outcome    text not null check (proposer_reservation_outcome in ('RELEASED', 'CONSUMED')),
  recipient_reservation_outcome   text not null check (recipient_reservation_outcome in ('RELEASED', 'CONSUMED')),

  -- §19, §32: real FKs are safe and correct here (unlike wallet_transactions'
  -- OWN pool_id/entry_id/settlement_id columns, which stay soft — see that
  -- migration's own comment) because THIS table is the side doing the
  -- referencing, and wallet_transactions rows are permanent/append-only
  -- (forbid_audit_log_mutation) — they can never be deleted out from under
  -- this FK, so this table can never become permanently undeletable by
  -- virtue of referencing them (the exact hazard that made the OTHER
  -- direction unsafe).
  loser_wallet_transaction_id     uuid references public.wallet_transactions (id),
  winner_wallet_transaction_id    uuid references public.wallet_transactions (id),
  house_fee_transaction_id        uuid references public.wallet_transactions (id),

  idempotency_key                 text not null unique,
  settled_at                      timestamptz not null default now(),

  constraint monetary_position_settlements_win_or_void_shape check (
    (outcome = 'VOID' and winner_user_id is null and loser_user_id is null
       and fee_amount = 0 and winner_credit_amount = 0
       and loser_wallet_transaction_id is null and winner_wallet_transaction_id is null)
    or
    (outcome <> 'VOID' and winner_user_id is not null and loser_user_id is not null
       and winner_user_id <> loser_user_id and loser_wallet_transaction_id is not null)
  ),
  constraint monetary_position_settlements_fee_shape check (
    (fee_amount = 0 and house_fee_transaction_id is null) or (fee_amount > 0 and house_fee_transaction_id is not null)
  ),
  constraint monetary_position_settlements_winner_credit_shape check (
    (winner_credit_amount = 0 and winner_wallet_transaction_id is null)
    or (winner_credit_amount > 0 and winner_wallet_transaction_id is not null)
  ),
  constraint monetary_position_settlements_fee_not_exceeding_stake check (fee_amount <= stake),
  constraint monetary_position_settlements_conservation check (winner_credit_amount + fee_amount <= stake)
);

create index idx_monetary_position_settlements_winner on public.monetary_position_settlements (winner_user_id, settled_at desc);
create index idx_monetary_position_settlements_loser on public.monetary_position_settlements (loser_user_id, settled_at desc);
create index idx_monetary_position_settlements_market on public.monetary_position_settlements (market_id);

comment on table public.monetary_position_settlements is
  'Milestone R10: the durable, fully immutable settlement record a monetary Position produces exactly once (position_id is UNIQUE). No UPDATE grant exists anywhere (see grants below) — nothing in this codebase ever mutates a settlement row after creation.';

-- Now that monetary_position_settlements exists, wire the forward FK from
-- monetary_positions (same reasoning as R9's own proposal->position FK).
alter table public.monetary_positions
  add constraint monetary_positions_settlement_id_fkey foreign key (settlement_id) references public.monetary_position_settlements (id);

-- RLS: participants (by proposer_user_id/recipient_user_id, which are
-- always populated for both WIN and VOID) + admin only — the same
-- conservative, no-public-record-exception privacy model R9 established
-- for money, never R7's own public-resolved-Challenge exception.
alter table public.monetary_position_settlements enable row level security;

create policy "select_own_monetary_position_settlements" on public.monetary_position_settlements for select to authenticated
  using (proposer_user_id = auth.uid() or recipient_user_id = auth.uid());
create policy "select_all_monetary_position_settlements_as_admin" on public.monetary_position_settlements for select to authenticated
  using (public.is_super_admin(auth.uid()));

grant select on public.monetary_position_settlements to authenticated;
grant select, insert on public.monetary_position_settlements to service_role; -- no update, no delete: fully immutable once created.

-- =====================================================================
-- settle_monetary_position(): the atomic settlement transaction (§15-16,
-- §31 pattern reused). (row, outcome) composite return — this function
-- DOES have "materialize nothing, then report a non-success outcome"
-- paths (not_eligible, invariant_violation both leave the Position
-- completely untouched, safe to retry later) alongside genuine terminal
-- mutation paths (settled_win, settled_void) and a pure-replay path
-- (already_settled) — the same reasoning R5/R7/R9 already documented for
-- their own composite-returning RPCs.
--
-- Combined lock order, explicit: Position row -> both Pick rows (ascending
-- predictions.id, R7/R9's own ordering, reused verbatim) -> both
-- wallet_reservations rows (ascending id) -> whichever wallet_balances
-- rows release_reservation()/consume_reservation()/apply_wallet_transaction()
-- themselves lock internally. No function anywhere in this codebase ever
-- locks two arbitrary wallet_reservations rows together except this one,
-- and idx_monetary_positions_proposer_reservation/idx_monetary_positions_
-- recipient_reservation (R9) guarantee no other Position ever shares
-- either reservation this function locks — so this ordering cannot
-- deadlock against any other Position's own settlement, against R9's own
-- accept_monetary_proposal()/decline/withdraw (Pick-lock ordering only, or
-- a single reservation lock, never two together), or against R8's own
-- reserve/release/consume (single reservation, then wallet_balances,
-- never two reservations at once).
-- =====================================================================
create type public.settle_monetary_position_result as (
  position public.monetary_positions,
  settlement public.monetary_position_settlements,
  outcome text
);

create or replace function public.settle_monetary_position(p_position_id uuid)
returns public.settle_monetary_position_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position public.monetary_positions;
  v_settlement public.monetary_position_settlements;
  v_lower_pred public.predictions;
  v_upper_pred public.predictions;
  v_proposer_pred public.predictions;
  v_recipient_pred public.predictions;
  v_lower_res public.wallet_reservations;
  v_upper_res public.wallet_reservations;
  v_proposer_reservation public.wallet_reservations;
  v_recipient_reservation public.wallet_reservations;
  v_winner_reservation public.wallet_reservations;
  v_loser_reservation public.wallet_reservations;
  v_outcome text;
  v_market_result text;
  v_winner_user_id uuid;
  v_loser_user_id uuid;
  v_proposer_reservation_outcome text;
  v_recipient_reservation_outcome text;
  v_fee_amount bigint := 0;
  v_winner_credit_amount bigint := 0;
  v_consume_result public.consume_reservation_result;
  v_winner_txn public.wallet_transactions;
  v_house_txn public.wallet_transactions;
  v_winner_txn_id uuid := null;
  v_house_txn_id uuid := null;
  v_idempotency_key text;
begin
  select * into v_position from public.monetary_positions where id = p_position_id for update;
  if not found then
    raise exception 'position_not_found';
  end if;

  -- §17, §76: idempotent retry — a Position already terminal (from a prior
  -- successful run of this exact function) returns its existing
  -- settlement unconditionally, re-deriving nothing.
  if v_position.settlement_status <> 'COMMITTED' then
    select * into v_settlement from public.monetary_position_settlements where id = v_position.settlement_id;
    return (v_position, v_settlement, 'already_settled')::public.settle_monetary_position_result;
  end if;

  -- Deterministic ascending-id Pick lock order, reused verbatim from R7/R9.
  if v_position.proposer_prediction_id < v_position.recipient_prediction_id then
    select * into v_lower_pred from public.predictions where id = v_position.proposer_prediction_id for update;
    select * into v_upper_pred from public.predictions where id = v_position.recipient_prediction_id for update;
    v_proposer_pred := v_lower_pred;
    v_recipient_pred := v_upper_pred;
  else
    select * into v_lower_pred from public.predictions where id = v_position.recipient_prediction_id for update;
    select * into v_upper_pred from public.predictions where id = v_position.proposer_prediction_id for update;
    v_proposer_pred := v_upper_pred;
    v_recipient_pred := v_lower_pred;
  end if;

  -- §22, §42, §43: not eligible until BOTH Picks are graded — an
  -- unresolved or postponed Game leaves this a safe no-op, never a guess,
  -- never a VOID.
  if v_proposer_pred.lifecycle_state <> 'GRADED' or v_recipient_pred.lifecycle_state <> 'GRADED' then
    return (v_position, null, 'not_eligible')::public.settle_monetary_position_result;
  end if;

  -- §23, §46, §72: this reads the Market's own authoritative result via
  -- the ONE place it is ever computed (lib/predictions/grading.ts's
  -- runGradingJob -> computeSportsMarketOutcome) — never a second,
  -- independently-reimplemented scoring pass in SQL, and never a
  -- participant's own claim. Both Picks were graded from the exact same
  -- Market/fixture at the exact same moment, so reading their own
  -- already-graded, immutable `result` back out is reading the Market's
  -- result, not "settling from Prediction result alone" as a substitute
  -- financial authority — there is no other authority to substitute for.
  if v_proposer_pred.result = 'VOID' and v_recipient_pred.result = 'VOID' then
    v_outcome := 'VOID';
    v_market_result := 'VOID';
  elsif v_proposer_pred.result = 'CORRECT' and v_recipient_pred.result = 'INCORRECT' then
    v_outcome := 'PROPOSER_WINS';
    v_market_result := v_proposer_pred.resolved_outcome_snapshot;
  elsif v_recipient_pred.result = 'CORRECT' and v_proposer_pred.result = 'INCORRECT' then
    v_outcome := 'RECIPIENT_WINS';
    v_market_result := v_recipient_pred.resolved_outcome_snapshot;
  else
    -- Structurally unreachable under this codebase's own grading
    -- invariants (opposing selections against one deterministic Market
    -- outcome cannot produce any other combination) — fail closed rather
    -- than guess (§38, §58). Position stays COMMITTED, untouched.
    return (v_position, null, 'invariant_violation')::public.settle_monetary_position_result;
  end if;

  -- Lock both reservations, deterministic ascending-id order. Verify each
  -- is exactly what the Position itself claims — correct owner, correct
  -- amount, still ACTIVE (§27-28, §81-83) — never mutate anything if this
  -- fails; that would hide accounting corruption rather than surface it.
  if v_position.proposer_reservation_id < v_position.recipient_reservation_id then
    select * into v_lower_res from public.wallet_reservations where id = v_position.proposer_reservation_id for update;
    select * into v_upper_res from public.wallet_reservations where id = v_position.recipient_reservation_id for update;
    v_proposer_reservation := v_lower_res;
    v_recipient_reservation := v_upper_res;
  else
    select * into v_lower_res from public.wallet_reservations where id = v_position.recipient_reservation_id for update;
    select * into v_upper_res from public.wallet_reservations where id = v_position.proposer_reservation_id for update;
    v_proposer_reservation := v_upper_res;
    v_recipient_reservation := v_lower_res;
  end if;

  if v_proposer_reservation.status <> 'ACTIVE' or v_proposer_reservation.user_id <> v_position.proposer_user_id or v_proposer_reservation.amount <> v_position.stake
     or v_recipient_reservation.status <> 'ACTIVE' or v_recipient_reservation.user_id <> v_position.recipient_user_id or v_recipient_reservation.amount <> v_position.stake
  then
    return (v_position, null, 'invariant_violation')::public.settle_monetary_position_result;
  end if;

  v_idempotency_key := 'p2p_settlement:' || v_position.id;

  if v_outcome = 'VOID' then
    -- §7: neither participant wins economically — release both holds,
    -- transfer nothing, no fee.
    perform public.release_reservation(v_proposer_reservation.id);
    perform public.release_reservation(v_recipient_reservation.id);

    insert into public.monetary_position_settlements (
      position_id, market_id, proposer_user_id, recipient_user_id, outcome,
      winner_user_id, loser_user_id, stake, fee_bps, fee_amount, winner_credit_amount,
      market_result, proposer_prediction_result, recipient_prediction_result,
      proposer_reservation_outcome, recipient_reservation_outcome,
      loser_wallet_transaction_id, winner_wallet_transaction_id, house_fee_transaction_id,
      idempotency_key
    ) values (
      v_position.id, v_position.market_id, v_position.proposer_user_id, v_position.recipient_user_id, 'VOID',
      null, null, v_position.stake, v_position.fee_bps, 0, 0,
      v_market_result, v_proposer_pred.result, v_recipient_pred.result,
      'RELEASED', 'RELEASED',
      null, null, null,
      v_idempotency_key
    ) returning * into v_settlement;

    update public.monetary_positions
      set settlement_status = 'VOIDED', settled_at = now(), settlement_id = v_settlement.id, updated_at = now()
      where id = v_position.id
      returning * into v_position;

    return (v_position, v_settlement, 'settled_void')::public.settle_monetary_position_result;
  end if;

  -- WIN path (§8-9, §26-31).
  if v_outcome = 'PROPOSER_WINS' then
    v_winner_user_id := v_position.proposer_user_id;
    v_loser_user_id := v_position.recipient_user_id;
    v_winner_reservation := v_proposer_reservation;
    v_loser_reservation := v_recipient_reservation;
    v_proposer_reservation_outcome := 'RELEASED';
    v_recipient_reservation_outcome := 'CONSUMED';
  else
    v_winner_user_id := v_position.recipient_user_id;
    v_loser_user_id := v_position.proposer_user_id;
    v_winner_reservation := v_recipient_reservation;
    v_loser_reservation := v_proposer_reservation;
    v_proposer_reservation_outcome := 'CONSUMED';
    v_recipient_reservation_outcome := 'RELEASED';
  end if;

  -- §27: the winner's own stake was never at risk — RELEASE it (restores
  -- availability, never a credit; their own money is not new value).
  perform public.release_reservation(v_winner_reservation.id);

  -- §28: the loser's stake becomes a real debit exactly once, atomically
  -- correlated to the reservation it came from — reuses R8's own
  -- consume_reservation() completely unmodified (only the new
  -- 'p2p_position_loss' enum value is new).
  v_consume_result := public.consume_reservation(
    v_loser_reservation.id,
    'p2p_position_loss'::public.wallet_transaction_type,
    null,
    'P2P Position settlement: stake lost',
    v_idempotency_key || ':loser-consume'
  );

  -- §13, §29: integer basis-point fee off the LOSING stake, floor
  -- rounding via Postgres integer division — the exact same convention
  -- pools.house_fee_bps already uses ((amount * bps) / 10000). Uses the
  -- Position's own immutable fee_bps SNAPSHOT (§62), never the live
  -- platform_settings.p2p_fee_bps value.
  v_fee_amount := (v_position.stake * v_position.fee_bps) / 10000;
  v_winner_credit_amount := v_position.stake - v_fee_amount;

  -- §14: never fabricate a zero-amount transaction on either side.
  if v_winner_credit_amount > 0 then
    v_winner_txn := public.apply_wallet_transaction(
      'user'::public.wallet_account_type, v_winner_user_id,
      'p2p_position_win'::public.wallet_transaction_type, 'credit'::public.wallet_direction,
      v_winner_credit_amount, null, 'P2P Position settlement: won', v_idempotency_key || ':winner-credit'
    );
    v_winner_txn_id := v_winner_txn.id;
  end if;

  if v_fee_amount > 0 then
    v_house_txn := public.apply_wallet_transaction(
      'house'::public.wallet_account_type, null,
      'house_fee_credit'::public.wallet_transaction_type, 'credit'::public.wallet_direction,
      v_fee_amount, null, 'P2P Position settlement fee', v_idempotency_key || ':house-fee'
    );
    v_house_txn_id := v_house_txn.id;
  end if;

  insert into public.monetary_position_settlements (
    position_id, market_id, proposer_user_id, recipient_user_id, outcome,
    winner_user_id, loser_user_id, stake, fee_bps, fee_amount, winner_credit_amount,
    market_result, proposer_prediction_result, recipient_prediction_result,
    proposer_reservation_outcome, recipient_reservation_outcome,
    loser_wallet_transaction_id, winner_wallet_transaction_id, house_fee_transaction_id,
    idempotency_key
  ) values (
    v_position.id, v_position.market_id, v_position.proposer_user_id, v_position.recipient_user_id, v_outcome,
    v_winner_user_id, v_loser_user_id, v_position.stake, v_position.fee_bps, v_fee_amount, v_winner_credit_amount,
    v_market_result, v_proposer_pred.result, v_recipient_pred.result,
    v_proposer_reservation_outcome, v_recipient_reservation_outcome,
    (v_consume_result.wallet_transaction).id, v_winner_txn_id, v_house_txn_id,
    v_idempotency_key
  ) returning * into v_settlement;

  update public.monetary_positions
    set settlement_status = 'SETTLED', settled_at = now(), settlement_id = v_settlement.id, updated_at = now()
    where id = v_position.id
    returning * into v_position;

  return (v_position, v_settlement, 'settled_win')::public.settle_monetary_position_result;
end;
$$;

revoke all on function public.settle_monetary_position(uuid) from public, anon, authenticated;
grant execute on function public.settle_monetary_position(uuid) to service_role;

-- =====================================================================
-- accept_monetary_proposal() (R9) redefined here, unchanged in every
-- respect except ONE addition (§62): snapshot the current
-- platform_settings.p2p_fee_bps onto the new Position's own fee_bps at
-- the exact moment of commitment. This is a `create or replace` in this
-- NEW migration rather than an edit to R9's own already-applied migration
-- file — this codebase's own established discipline (see
-- apply_wallet_transaction's own R8-era redefinition for precedent) never
-- rewrites a prior migration in place. Every other line below is
-- byte-for-byte identical to R9's own version.
-- =====================================================================
create or replace function public.accept_monetary_proposal(
  p_proposal_id uuid,
  p_recipient_user_id uuid
)
returns public.accept_monetary_proposal_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal public.monetary_proposals;
  v_lower public.predictions;
  v_upper public.predictions;
  v_proposer_pred public.predictions;
  v_recipient_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_enabled boolean;
  v_fee_bps integer;
  v_proposer_reservation public.wallet_reservations;
  v_recipient_balance_row public.wallet_balances;
  v_recipient_available bigint;
  v_recipient_reservation public.wallet_reservations;
  v_position public.monetary_positions;
  v_result_proposal public.monetary_proposals;
begin
  select * into v_proposal from public.monetary_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;

  if v_proposal.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  if v_proposal.status <> 'PENDING' then
    return (v_proposal, null, 'not_pending')::public.accept_monetary_proposal_result;
  end if;

  -- Acceptance itself creates a new economic commitment, so the feature
  -- gate covers it too, not just creation (§60's own "prevent NEW
  -- monetary commitments" — a Position is exactly that).
  select coalesce(monetary_p2p_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'monetary_p2p_disabled';
  end if;

  select f.internal_status, f.scheduled_start_utc
    into v_fixture_status, v_scheduled_start
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_proposal.market_id;

  if not found then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_invalidated')::public.accept_monetary_proposal_result;
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_cutoff')::public.accept_monetary_proposal_result;
  end if;

  -- Deterministic ascending-id Pick lock order (§34) — see this
  -- function's own header comment.
  if v_proposal.proposer_prediction_id < v_proposal.recipient_prediction_id then
    select * into v_lower from public.predictions where id = v_proposal.proposer_prediction_id for update;
    select * into v_upper from public.predictions where id = v_proposal.recipient_prediction_id for update;
    v_proposer_pred := v_lower;
    v_recipient_pred := v_upper;
  else
    select * into v_lower from public.predictions where id = v_proposal.recipient_prediction_id for update;
    select * into v_upper from public.predictions where id = v_proposal.proposer_prediction_id for update;
    v_proposer_pred := v_upper;
    v_recipient_pred := v_lower;
  end if;

  -- §35 race safety: a concurrent set_pick() CUTOFF-lock landing between
  -- our own cutoff check and acquiring these row locks is caught here,
  -- now that we hold them — identical reasoning to accept_call_bs().
  if (v_proposer_pred.lock_reason = 'CUTOFF') or (v_recipient_pred.lock_reason = 'CUTOFF') then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_cutoff')::public.accept_monetary_proposal_result;
  end if;

  -- §25, §35: revalidate current reality against the proposal's own
  -- immutable snapshots — a Pick edit since proposal creation invalidates
  -- the specific disagreement this proposal named.
  if v_proposer_pred.selected_outcome <> v_proposal.proposer_selection_snapshot
     or v_recipient_pred.selected_outcome <> v_proposal.recipient_selection_snapshot
     or v_proposer_pred.lifecycle_state = 'GRADED'
     or v_recipient_pred.lifecycle_state = 'GRADED'
  then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_invalidated')::public.accept_monetary_proposal_result;
  end if;

  -- §39: the proposer reservation must still be exactly what it was —
  -- ACTIVE, correct owner, correct amount. Never recreated if missing or
  -- wrong; that would hide accounting corruption rather than surface it.
  -- No proposal-state mutation here on this path — a genuine anomaly is
  -- left for reconciliation/support to investigate, not silently
  -- resolved by this function guessing at intent.
  select * into v_proposer_reservation from public.wallet_reservations where id = v_proposal.proposer_reservation_id for update;
  if not found
     or v_proposer_reservation.status <> 'ACTIVE'
     or v_proposer_reservation.user_id <> v_proposal.proposer_user_id
     or v_proposer_reservation.amount <> v_proposal.stake
  then
    return (v_proposal, null, 'proposer_reservation_invalid')::public.accept_monetary_proposal_result;
  end if;

  -- §30, §38: verify recipient's CURRENT available balance under a lock
  -- held for the rest of this transaction, then reserve it via the same
  -- primitive — reserve_funds()'s own internal FOR UPDATE on this exact
  -- row is a harmless re-lock (already held by this transaction), so no
  -- amount could have changed between this check and that call.
  select * into v_recipient_balance_row from public.wallet_balances where user_id = p_recipient_user_id and account_type = 'user' for update;
  if not found then
    return (v_proposal, null, 'insufficient_recipient_balance')::public.accept_monetary_proposal_result;
  end if;
  v_recipient_available := v_recipient_balance_row.balance - v_recipient_balance_row.reserved_balance;
  if v_proposal.stake > v_recipient_available then
    return (v_proposal, null, 'insufficient_recipient_balance')::public.accept_monetary_proposal_result;
  end if;

  v_recipient_reservation := public.reserve_funds(p_recipient_user_id, v_proposal.stake, 'monetary_position'::public.wallet_reservation_purpose, v_proposal.idempotency_key || ':recipient-reserve');

  -- §32-33: lock both Picks — but never overwrite an existing compatible
  -- lock (a Pick may already be CHALLENGE_ACCEPTED- or
  -- MONETARY_POSITION_ACCEPTED-locked from an earlier accepted free
  -- Challenge or a different Position on the same Pick — R7's own
  -- multiplicity, §50 extends it to money). Only ever set when still null.
  update public.predictions
    set locked_at = now(), lock_reason = 'MONETARY_POSITION_ACCEPTED', updated_at = now()
    where id in (v_proposer_pred.id, v_recipient_pred.id) and locked_at is null;

  -- R10 §62: snapshot the CURRENT platform fee rate onto this Position —
  -- the one addition this redefinition makes. Read fresh, right here, at
  -- the moment of commitment; never re-read live at settlement time.
  select coalesce(p2p_fee_bps, 0) into v_fee_bps from public.platform_settings where id = true;

  insert into public.monetary_positions (
    proposal_id, market_id, proposer_user_id, recipient_user_id,
    proposer_prediction_id, recipient_prediction_id,
    proposer_selection_snapshot, recipient_selection_snapshot,
    stake, proposer_reservation_id, recipient_reservation_id, fee_bps
  ) values (
    v_proposal.id, v_proposal.market_id, v_proposal.proposer_user_id, v_proposal.recipient_user_id,
    v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id,
    v_proposal.proposer_selection_snapshot, v_proposal.recipient_selection_snapshot,
    v_proposal.stake, v_proposer_reservation.id, v_recipient_reservation.id, coalesce(v_fee_bps, 0)
  )
  returning * into v_position;

  update public.monetary_proposals
    set status = 'ACCEPTED', accepted_at = now(), position_id = v_position.id, updated_at = now()
    where id = v_proposal.id
    returning * into v_result_proposal;

  return (v_result_proposal, v_position, 'accepted')::public.accept_monetary_proposal_result;
end;
$$;

revoke all on function public.accept_monetary_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_monetary_proposal(uuid, uuid) to service_role;
