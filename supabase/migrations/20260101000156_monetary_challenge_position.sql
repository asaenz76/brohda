-- Milestone R9 (docs/BROHDA_2_0_MILESTONE_MAP.md, Monetary Challenge +
-- Position). Additive only. Sits on top of R7's free `challenges` (social
-- layer, untouched, unpolluted with money) and R8's wallet reservation
-- primitive (`reserve_funds`/`release_reservation`, reused unchanged).
-- Introduces the economic negotiation layer (monetary_proposals) and the
-- committed bilateral contract it produces (monetary_positions). No
-- settlement, no payout, no fee — R10's own concern. See
-- docs/architecture/monetary-challenge-position.md for the full rationale.
--
-- Repository-truth-gather confirmed every claim this task asked to verify:
-- `challenges` has zero money columns (id, market_id, both user ids, both
-- prediction ids, both selection snapshots, status, result, three
-- timestamps only); `wallet_reservation_purpose` currently contains only
-- `withdrawal_request`; `predictions.lock_reason` CHECK currently allows
-- only 'CUTOFF'/'CHALLENGE_ACCEPTED'; R7's multiplicity (one Pick, many
-- accepted free Challenges) and `CHALLENGE_ACCEPTED` locking are both
-- functional and unchanged; every monetary amount in this codebase is a
-- plain `bigint` (cents) — no floating point anywhere. Nothing
-- contradicted repository reality; no STOP-and-report was warranted.

-- =====================================================================
-- Reservation purpose (§14): exactly the one real value R9 itself needs —
-- 'monetary_position', covering a reservation's meaning both while its
-- proposal is merely PENDING and once it becomes part of a committed
-- Position (the reservation's own life doesn't change shape at that
-- transition — only what references it does). Not 'monetary_challenge':
-- the reservation is fundamentally about the committed MONEY, which is
-- the Position's own vocabulary, not the social-negotiation layer's.
-- =====================================================================
alter type public.wallet_reservation_purpose add value 'monetary_position';

-- =====================================================================
-- Lock reason (§33): a monetary Position can exist WITHOUT any underlying
-- free Challenge (§10.B, direct proposals), so reusing 'CHALLENGE_ACCEPTED'
-- for a money-only lock would create false historical semantics — it
-- would claim a free Call BS caused a lock that a monetary proposal
-- actually caused. A new, deliberate reason preserves real provenance
-- (§33's own instruction: "Do NOT casually add a new reason if it creates
-- false historical semantics" cuts both ways — reusing the wrong reason
-- is exactly as inaccurate as inventing an unnecessary one). Widening a
-- plain CHECK constraint (not a native enum, matching R5's own original
-- choice for this column) rather than replacing it.
-- =====================================================================
alter table public.predictions drop constraint predictions_lock_reason_check;
alter table public.predictions add constraint predictions_lock_reason_check
  check (lock_reason in ('CUTOFF', 'CHALLENGE_ACCEPTED', 'MONETARY_POSITION_ACCEPTED'));

comment on column public.predictions.lock_reason is
  'Why this Pick locked. CUTOFF = the configured Pick cutoff before kickoff passed (R5). CHALLENGE_ACCEPTED = a free Call BS Challenge was accepted (R7). MONETARY_POSITION_ACCEPTED = a monetary proposal was accepted, committing a Position (R9) — distinct from CHALLENGE_ACCEPTED because a monetary Position can exist without any underlying free Challenge. Whichever reason got here first is preserved forever — a Pick already locked for any reason is never re-locked or relabeled by a later cause (see accept_monetary_proposal()''s own lock-only-if-null update).';

-- =====================================================================
-- monetary_proposals (§6-7): the negotiation/offer object. Distinct from
-- Position on purpose — its own invariants (mutable lifecycle, a single
-- proposer reservation, no bilateral commitment yet) are meaningfully
-- different from a committed Position's (§7's own worked explanation).
--
-- FK/delete discipline (§76) deliberately DIVERGES from `challenges`'
-- own `on delete cascade` on user references: this is financial history,
-- not social history, so user references are plain, non-cascading FKs
-- (`user_profiles` rows are, in practice, never hard-deleted anyway —
-- verified directly: close_own_account() only ever soft-scrubs
-- `is_active = false` and nulls PII fields, the row and its id persist
-- forever — but the conservative choice costs nothing and is what this
-- milestone's own task explicitly asks for). `proposer_prediction_id`/
-- `recipient_prediction_id` are real FKs (predictions are never deleted,
-- same reasoning `prediction_revisions`/`challenges` already established).
-- `market_id` stays a soft reference, matching `predictions.market_id`/
-- `challenges.market_id`'s own precedent exactly (permanent history must
-- survive independently of `markets`' own lifecycle).
-- =====================================================================
create table public.monetary_proposals (
  id                             uuid primary key default gen_random_uuid(),
  market_id                      uuid not null,
  proposer_user_id               uuid not null references public.user_profiles (id),
  recipient_user_id              uuid not null references public.user_profiles (id),
  proposer_prediction_id         uuid not null references public.predictions (id),
  recipient_prediction_id        uuid not null references public.predictions (id),

  -- Snapshotted immutably at creation (§24) — never re-derived from the
  -- mutable, pre-lock predictions.selected_outcome later. Acceptance
  -- revalidates current Pick state against these, exactly like R7's own
  -- challenger_selection_snapshot/recipient_selection_snapshot.
  proposer_selection_snapshot    text not null check (proposer_selection_snapshot in ('YES', 'NO')),
  recipient_selection_snapshot   text not null check (recipient_selection_snapshot in ('YES', 'NO')),

  -- Equal-stake model only (§19) — one amount, not two. No odds, no
  -- asymmetric exposure.
  stake                          bigint not null check (stake > 0),

  -- Optional escalation reference (§11) — never required for a direct
  -- proposal (§10.B). Real FK: challenges rows are never deleted.
  source_challenge_id            uuid references public.challenges (id),

  -- The proposer's funds, held from the moment this proposal exists
  -- (§13) — never nullable, since call_bs()'s own atomic-creation
  -- pattern (this migration's propose_money(), below) never inserts a
  -- proposal row without one already existing in the same transaction.
  proposer_reservation_id        uuid not null references public.wallet_reservations (id),

  -- Lifecycle stage only (§26), mirroring challenges.status's own plain
  -- text+CHECK convention (not a native enum, matching R7's precedent for
  -- this exact shape of "negotiation lifecycle" column, as distinct from
  -- R8's wallet_reservation_status/purpose, which are native enums for a
  -- different reason — see architecture doc).
  status                         text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),

  -- Set only once ACCEPTED — forward correlation to the Position this
  -- proposal produced (mirrors wallet_reservations.consumed_transaction_id's
  -- own "set via UPDATE once the later row exists" pattern — the ordering
  -- problem R8 hit does NOT recur here, since the Position is always
  -- created strictly after the proposal already exists, in the same
  -- transaction, so setting this via UPDATE after the Position INSERT is
  -- always safe). Plain uuid here, not an inline FK — monetary_positions
  -- is defined further down this same file; the real FK is added by a
  -- separate ALTER TABLE once that table exists (see the bottom of this
  -- migration), not because the constraint itself needs deferring.
  position_id                    uuid,

  accepted_at                    timestamptz,
  declined_at                    timestamptz,
  expired_at                     timestamptz,
  withdrawn_at                   timestamptz,

  idempotency_key                text not null unique,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  constraint monetary_proposals_different_users check (proposer_user_id <> recipient_user_id),
  constraint monetary_proposals_different_picks check (proposer_prediction_id <> recipient_prediction_id),
  constraint monetary_proposals_selections_oppose check (proposer_selection_snapshot <> recipient_selection_snapshot),
  constraint monetary_proposals_accepted_at_shape check ((status = 'ACCEPTED') = (accepted_at is not null)),
  constraint monetary_proposals_declined_at_shape check ((status = 'DECLINED') = (declined_at is not null)),
  constraint monetary_proposals_expired_at_shape check ((status = 'EXPIRED') = (expired_at is not null)),
  constraint monetary_proposals_withdrawn_at_shape check ((status = 'WITHDRAWN') = (withdrawn_at is not null)),
  constraint monetary_proposals_position_id_shape check ((status = 'ACCEPTED') = (position_id is not null))
);

-- `position_id`'s real FK is added near the bottom of this migration,
-- once `monetary_positions` (defined below) actually exists — a plain
-- forward-reference-to-a-later-table problem, not a deferred-constraint
-- one: every write to `position_id` happens inside
-- accept_monetary_proposal(), strictly after the Position row it points
-- to has just been inserted in that same transaction, so an ordinary,
-- immediately-checked FK is correct and sufficient.

create index idx_monetary_proposals_proposer on public.monetary_proposals (proposer_user_id, created_at desc);
create index idx_monetary_proposals_recipient on public.monetary_proposals (recipient_user_id, created_at desc);
create index idx_monetary_proposals_market on public.monetary_proposals (market_id);

-- Structural duplicate prevention (§51-52): at most one active proposal
-- per opposing-Pick pair, in either direction, regardless of stake —
-- identical mechanism to challenges_one_pending_pair (R7), reused
-- deliberately rather than reinvented. A terminal proposal (DECLINED/
-- EXPIRED/WITHDRAWN) never blocks a fresh one between the same pair.
create unique index monetary_proposals_one_pending_pair
  on public.monetary_proposals (least(proposer_prediction_id, recipient_prediction_id), greatest(proposer_prediction_id, recipient_prediction_id))
  where status = 'PENDING';

alter table public.monetary_proposals enable row level security;

-- Privacy (§65): more conservative than R7's own Challenge (which makes a
-- RESOLVED social Challenge a public record). Money gets NO public-record
-- exception — participants and staff only, deliberately, per this
-- milestone's own explicit instruction.
create policy "participants_can_read_own_monetary_proposals" on public.monetary_proposals for select to authenticated
  using (proposer_user_id = auth.uid() or recipient_user_id = auth.uid());
create policy "select_all_monetary_proposals_as_admin" on public.monetary_proposals for select to authenticated
  using (public.is_super_admin(auth.uid()));

grant select on public.monetary_proposals to authenticated;
grant select, insert, update on public.monetary_proposals to service_role;

-- =====================================================================
-- monetary_positions (§40-42): the committed bilateral economic contract.
-- Deliberately minimal — no status/settlement columns (§41: "Do not
-- implement R10 transitions... avoid pretending ACCEPTED/WON/LOST are
-- Position states"). A Position's mere existence means COMMITTED; R10
-- adds whatever settlement columns it actually needs via its own
-- additive migration later, exactly like every prior milestone's own new
-- FK/reference column was added only when the milestone that needed it
-- arrived (R6's notifications.post_id, R7's notifications.challenge_id,
-- R8's wallet_requests.reservation_id) — never spekulatively pre-built.
-- =====================================================================
create table public.monetary_positions (
  id                             uuid primary key default gen_random_uuid(),
  proposal_id                    uuid not null references public.monetary_proposals (id),

  market_id                      uuid not null,
  proposer_user_id               uuid not null references public.user_profiles (id),
  recipient_user_id              uuid not null references public.user_profiles (id),
  proposer_prediction_id         uuid not null references public.predictions (id),
  recipient_prediction_id        uuid not null references public.predictions (id),
  proposer_selection_snapshot    text not null check (proposer_selection_snapshot in ('YES', 'NO')),
  recipient_selection_snapshot   text not null check (recipient_selection_snapshot in ('YES', 'NO')),
  stake                          bigint not null check (stake > 0),

  -- Exactly two reservations, one per side (§68), both required, both
  -- distinct. Real FKs: wallet_reservations rows are permanent.
  proposer_reservation_id        uuid not null references public.wallet_reservations (id),
  recipient_reservation_id       uuid not null references public.wallet_reservations (id),

  committed_at                   timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  constraint monetary_positions_different_users check (proposer_user_id <> recipient_user_id),
  constraint monetary_positions_different_picks check (proposer_prediction_id <> recipient_prediction_id),
  constraint monetary_positions_selections_oppose check (proposer_selection_snapshot <> recipient_selection_snapshot),
  constraint monetary_positions_different_reservations check (proposer_reservation_id <> recipient_reservation_id)
);

create index idx_monetary_positions_proposer on public.monetary_positions (proposer_user_id, committed_at desc);
create index idx_monetary_positions_recipient on public.monetary_positions (recipient_user_id, committed_at desc);
create index idx_monetary_positions_market on public.monetary_positions (market_id);
-- Enforces "exactly one reservation per Position side, never shared
-- across Positions" (§68) structurally: a reservation id appearing as
-- either side of more than one Position row would violate these.
create unique index idx_monetary_positions_proposer_reservation on public.monetary_positions (proposer_reservation_id);
create unique index idx_monetary_positions_recipient_reservation on public.monetary_positions (recipient_reservation_id);

alter table public.monetary_positions enable row level security;

create policy "participants_can_read_own_monetary_positions" on public.monetary_positions for select to authenticated
  using (proposer_user_id = auth.uid() or recipient_user_id = auth.uid());
create policy "select_all_monetary_positions_as_admin" on public.monetary_positions for select to authenticated
  using (public.is_super_admin(auth.uid()));

grant select on public.monetary_positions to authenticated;
grant select, insert on public.monetary_positions to service_role;

alter table public.monetary_proposals add constraint monetary_proposals_position_id_fkey
  foreign key (position_id) references public.monetary_positions (id);

comment on table public.monetary_proposals is
  'The economic offer/negotiation object (R9, §6-7). NOT the committed agreement — see monetary_positions. A proposal that becomes ACCEPTED produces exactly one monetary_positions row (position_id).';
comment on table public.monetary_positions is
  'The durable, immutable, committed bilateral economic contract (R9, §7, §40-42). Both participant reservations remain ACTIVE after commitment — R9 never consumes or releases them; only a future R10 settlement operation may. No status/settlement column exists here by design — a Position''s mere existence means COMMITTED.';

-- Milestone R9 configuration (§60, §86). Off by default, matching every
-- prior new-mechanic convention (R7's call_bs_enabled, R8's — none
-- needed, R6's post_publication_enabled/community_distribution_enabled).
-- Deliberately NO min/max stake columns (§21, Option B): no existing
-- product decision specifies real values, and inventing one would be
-- exactly the kind of unjustified restrictive number this milestone's
-- own task warns against. Documented explicitly as a genuinely deferred
-- future policy decision, not silently invented.
alter table public.platform_settings
  add column monetary_p2p_enabled boolean not null default false,
  add column monetary_proposal_rate_limit_window_seconds integer not null default 60 check (monetary_proposal_rate_limit_window_seconds >= 1),
  add column monetary_proposal_rate_limit_max_attempts integer not null default 10 check (monetary_proposal_rate_limit_max_attempts >= 1);

comment on column public.platform_settings.monetary_p2p_enabled is
  'Whether a new monetary proposal may be created OR an existing PENDING one accepted. Off by default. Never affects an already-COMMITTED Position — disabling this can only prevent new economic commitments, never corrupt or release one that already exists (§60).';
comment on column public.platform_settings.monetary_proposal_rate_limit_window_seconds is
  'Monetary proposal creation rate-limit window, read live by lib/rate-limit/monetary-proposals.ts.';
comment on column public.platform_settings.monetary_proposal_rate_limit_max_attempts is
  'Monetary proposal creation rate-limit attempt cap within the configured window.';

-- Link a notification to its monetary proposal (mirrors notifications.
-- post_id/challenge_id's own real, non-cascading, nullable-FK convention).
alter table public.notifications add column monetary_proposal_id uuid references public.monetary_proposals (id);

-- =====================================================================
-- propose_money(): §12-13, §63. Atomically verifies eligibility, reserves
-- the proposer's full stake (nested call to reserve_funds — same
-- primitive R8 already proved correct, not reimplemented), and creates
-- the PENDING proposal — all in one transaction, so "proposal PENDING
-- with no reservation" and "reservation ACTIVE with no proposal" are both
-- structurally impossible outcomes, never just conventions.
--
-- The only client-meaningful inputs are the recipient's Pick id, the
-- stake, and an optional source Challenge id (§63) — everything else
-- (proposer's own Pick, the Market, both selection snapshots) is derived
-- server-side, exactly mirroring call_bs()'s own §9 discipline.
--
-- Plain exceptions throughout (not a composite return): unlike
-- accept_monetary_proposal below, nothing here is materialized before a
-- possible rejection — the same reasoning call_bs() itself already
-- established over set_pick()'s own composite-return pattern.
-- =====================================================================
create or replace function public.propose_money(
  p_proposer_user_id uuid,
  p_recipient_prediction_id uuid,
  p_stake bigint,
  p_idempotency_key text,
  p_source_challenge_id uuid default null
)
returns public.monetary_proposals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.monetary_proposals;
  v_recipient_pred public.predictions;
  v_proposer_pred public.predictions;
  v_challenge public.challenges;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_enabled boolean;
  v_reservation public.wallet_reservations;
  v_result public.monetary_proposals;
begin
  select * into v_existing from public.monetary_proposals where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_stake <= 0 then
    raise exception 'stake must be positive';
  end if;

  select coalesce(monetary_p2p_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'monetary_p2p_disabled';
  end if;

  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  if not found then
    raise exception 'recipient_pick_not_found';
  end if;

  select * into v_proposer_pred from public.predictions where user_id = p_proposer_user_id and market_id = v_recipient_pred.market_id;
  if not found then
    raise exception 'proposer_pick_not_found';
  end if;

  if v_proposer_pred.user_id = v_recipient_pred.user_id then
    raise exception 'self_proposal';
  end if;

  if v_proposer_pred.selected_outcome = v_recipient_pred.selected_outcome then
    raise exception 'picks_not_opposing';
  end if;

  if v_proposer_pred.lifecycle_state = 'GRADED' or v_recipient_pred.lifecycle_state = 'GRADED' then
    raise exception 'pick_already_graded';
  end if;

  select f.internal_status, f.scheduled_start_utc
    into v_fixture_status, v_scheduled_start
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_recipient_pred.market_id;

  if not found then
    raise exception 'market_not_found';
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    raise exception 'past_monetary_cutoff';
  end if;

  -- Escalation validation (§11): the Challenge must exist, be ACCEPTED,
  -- and name the exact same two participants and the exact same two
  -- Picks as this proposal — checked as unordered sets, since either
  -- party to an already-accepted free Challenge may be the one who
  -- escalates it to money (not necessarily the original challenger).
  if p_source_challenge_id is not null then
    select * into v_challenge from public.challenges where id = p_source_challenge_id;
    if not found then
      raise exception 'source_challenge_not_found';
    end if;
    if v_challenge.status <> 'ACCEPTED' then
      raise exception 'source_challenge_not_accepted';
    end if;
    if v_challenge.market_id <> v_recipient_pred.market_id then
      raise exception 'source_challenge_market_mismatch';
    end if;
    if not (
      (v_challenge.challenger_user_id = p_proposer_user_id and v_challenge.recipient_user_id = v_recipient_pred.user_id)
      or (v_challenge.challenger_user_id = v_recipient_pred.user_id and v_challenge.recipient_user_id = p_proposer_user_id)
    ) then
      raise exception 'source_challenge_participant_mismatch';
    end if;
    if not (
      (v_challenge.challenger_prediction_id = v_proposer_pred.id and v_challenge.recipient_prediction_id = v_recipient_pred.id)
      or (v_challenge.challenger_prediction_id = v_recipient_pred.id and v_challenge.recipient_prediction_id = v_proposer_pred.id)
    ) then
      raise exception 'source_challenge_pick_mismatch';
    end if;
  end if;

  -- Reserve the proposer's full stake atomically, in this same
  -- transaction (§13) — reserve_funds() itself raises
  -- 'insufficient_available_balance' if the proposer can't cover it,
  -- rolling back this entire function, including nothing having been
  -- inserted yet.
  v_reservation := public.reserve_funds(p_proposer_user_id, p_stake, 'monetary_position'::public.wallet_reservation_purpose, p_idempotency_key || ':proposer-reserve');

  begin
    insert into public.monetary_proposals (
      market_id, proposer_user_id, recipient_user_id,
      proposer_prediction_id, recipient_prediction_id,
      proposer_selection_snapshot, recipient_selection_snapshot,
      stake, source_challenge_id, proposer_reservation_id, idempotency_key
    ) values (
      v_recipient_pred.market_id, p_proposer_user_id, v_recipient_pred.user_id,
      v_proposer_pred.id, v_recipient_pred.id,
      v_proposer_pred.selected_outcome, v_recipient_pred.selected_outcome,
      p_stake, p_source_challenge_id, v_reservation.id, p_idempotency_key
    )
    returning * into v_result;
    return v_result;
  exception when unique_violation then
    -- monetary_proposals_one_pending_pair (§51-52): release the
    -- just-created reservation before failing — the whole function must
    -- leave no orphaned hold behind on this rejection path.
    perform public.release_reservation(v_reservation.id);
    raise exception 'duplicate_pending_proposal';
  end;
end;
$$;

revoke all on function public.propose_money(uuid, uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.propose_money(uuid, uuid, bigint, text, uuid) to service_role;

-- =====================================================================
-- accept_monetary_proposal(): §31, the heart of R9. (row, outcome)
-- composite return, mirroring accept_call_bs()'s own pattern exactly and
-- for the identical reason: this function DOES have "materialize a state
-- change (EXPIRE the proposal, release the proposer's hold), then report
-- a non-success outcome" paths, and a plain exception on those paths
-- would roll that materialization back — the same bug class R5's own
-- migration comment documents catching by direct SQL testing, re-applied
-- here deliberately rather than re-discovered by accident.
--
-- Combined lock order (§34), explicit: monetary proposal row -> both
-- Pick rows (ascending predictions.id, exactly R7's own accept_call_bs
-- ordering, reused verbatim) -> proposer's wallet_reservations row (by
-- its own PK) -> recipient's wallet_balances row (via the nested
-- reserve_funds() call, which takes its own FOR UPDATE lock on exactly
-- that row). No function anywhere in this codebase ever needs the
-- reverse of any pair in this chain, so this ordering cannot deadlock
-- against Pick editing (set_pick, single-row lock only), free Challenge
-- acceptance (same Pick-lock ordering, no wallet lock at all), or R8's
-- own reserve/release/consume (reservation-row-then-wallet_balances,
-- never the other way, and never a Pick row at all).
-- =====================================================================
create type public.accept_monetary_proposal_result as (
  proposal public.monetary_proposals,
  position public.monetary_positions,
  outcome text
);

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

  insert into public.monetary_positions (
    proposal_id, market_id, proposer_user_id, recipient_user_id,
    proposer_prediction_id, recipient_prediction_id,
    proposer_selection_snapshot, recipient_selection_snapshot,
    stake, proposer_reservation_id, recipient_reservation_id
  ) values (
    v_proposal.id, v_proposal.market_id, v_proposal.proposer_user_id, v_proposal.recipient_user_id,
    v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id,
    v_proposal.proposer_selection_snapshot, v_proposal.recipient_selection_snapshot,
    v_proposal.stake, v_proposer_reservation.id, v_recipient_reservation.id
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

-- =====================================================================
-- decline_monetary_proposal() / withdraw_monetary_proposal(): §27, §29.
-- Both plain-exception, both release the proposer's reservation via a
-- nested call to the same R8 primitive — nothing here reimplements
-- release semantics. §29's own recommended default (proposer may
-- withdraw a PENDING proposal; never after acceptance) is implemented
-- directly, not deferred, since the risk asymmetry R7 used to justify
-- deferring free-Challenge cancellation (no money at stake) does not
-- apply here — real funds sit reserved for as long as the proposal is
-- outstanding.
-- =====================================================================
create or replace function public.decline_monetary_proposal(
  p_proposal_id uuid,
  p_recipient_user_id uuid
)
returns public.monetary_proposals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal public.monetary_proposals;
begin
  select * into v_proposal from public.monetary_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;

  if v_proposal.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  if v_proposal.status <> 'PENDING' then
    raise exception 'not_pending';
  end if;

  perform public.release_reservation(v_proposal.proposer_reservation_id);

  update public.monetary_proposals set status = 'DECLINED', declined_at = now(), updated_at = now()
    where id = v_proposal.id
    returning * into v_proposal;

  return v_proposal;
end;
$$;

revoke all on function public.decline_monetary_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.decline_monetary_proposal(uuid, uuid) to service_role;

create or replace function public.withdraw_monetary_proposal(
  p_proposal_id uuid,
  p_proposer_user_id uuid
)
returns public.monetary_proposals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal public.monetary_proposals;
begin
  select * into v_proposal from public.monetary_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal_not_found';
  end if;

  if v_proposal.proposer_user_id <> p_proposer_user_id then
    raise exception 'not_proposer';
  end if;

  if v_proposal.status <> 'PENDING' then
    raise exception 'not_pending';
  end if;

  perform public.release_reservation(v_proposal.proposer_reservation_id);

  update public.monetary_proposals set status = 'WITHDRAWN', withdrawn_at = now(), updated_at = now()
    where id = v_proposal.id
    returning * into v_proposal;

  return v_proposal;
end;
$$;

revoke all on function public.withdraw_monetary_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.withdraw_monetary_proposal(uuid, uuid) to service_role;
