-- Monetary policy controls: configurable stake limits + exactly one active
-- monetary Position per unordered user pair per Market.
-- Forward-only. Production was audited before this was written: 3 COMMITTED
-- Positions on 3 different Markets, no pair/Market conflicts, so the unique
-- index below can be created without touching any real Position.
--
-- 1. Stake limits — platform_settings.monetary_p2p_{min,max}_stake_cents,
--    integer cents, CHECK min > 0 and max >= min. Seeded 100 / 10000 ($1.00 /
--    $100.00), the values approved by the product owner; Super Admin edits them
--    from then on (update_monetary_settings, optimistic-concurrency guarded and
--    audited like every other setting). propose_money() reads them live and
--    raises stake_below_minimum / stake_above_maximum. They govern NEW
--    proposals only — a proposal's terms are immutable once created.
--
-- 2. Pair exclusivity — see the comments inside propose_money() and
--    accept_monetary_proposal(). Two layers: a deterministic advisory lock on
--    the canonical pair key serialises every send and every accept for a pair,
--    and a partial unique index on the same canonical key is the invariant
--    backstop (a second COMMITTED Position for the pair cannot exist even if a
--    future code path forgot the lock; the violation rolls the whole call
--    back, so nothing it reserved can be orphaned). The pending-proposal
--    index (monetary_proposals_one_pending_pair) already used the same
--    canonical, unordered key, so A->B and B->A pending duplicates were
--    already impossible; this closes the remaining gap, a second Position
--    after the first is accepted.
--
-- "Active" = settlement_status 'COMMITTED'. SETTLED and VOIDED are terminal and
-- do not block; in practice a settled pair's Market is graded, which propose_money()
-- already refuses (pick_already_graded), so no extra permanent-history ban is added.
--
-- Deploy order is safe either way: apply this migration first and the old app
-- keeps working (the settings RPC's new parameters default to "unchanged";
-- the old app never sends stake limits and simply gets the new typed errors as
-- its generic fallback copy); the new app needs this migration for the admin
-- fields and the new errors.

alter table public.platform_settings
  add column monetary_p2p_min_stake_cents bigint not null default 100,
  add column monetary_p2p_max_stake_cents bigint not null default 10000;

alter table public.platform_settings
  add constraint platform_settings_monetary_min_stake_positive check (monetary_p2p_min_stake_cents > 0),
  add constraint platform_settings_monetary_max_stake_not_below_min check (monetary_p2p_max_stake_cents >= monetary_p2p_min_stake_cents);

comment on column public.platform_settings.monetary_p2p_min_stake_cents is
  'Smallest stake, in cents, a NEW monetary proposal may carry. Read live by propose_money(). Does not affect already-created proposals or committed Positions.';
comment on column public.platform_settings.monetary_p2p_max_stake_cents is
  'Largest stake, in cents, a NEW monetary proposal may carry (the effective ceiling for a user is also their available balance). Read live by propose_money().';

-- Exactly one COMMITTED Position per unordered pair of Picks (= user pair + Market).
create unique index monetary_positions_one_committed_pair
  on public.monetary_positions (
    least(proposer_prediction_id, recipient_prediction_id),
    greatest(proposer_prediction_id, recipient_prediction_id)
  )
  where settlement_status = 'COMMITTED';

CREATE OR REPLACE FUNCTION public.propose_money(p_proposer_user_id uuid, p_recipient_prediction_id uuid, p_stake bigint, p_idempotency_key text, p_source_challenge_id uuid DEFAULT NULL::uuid)
 RETURNS monetary_proposals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_proposer_active boolean;
  v_recipient_active boolean;
  v_min_stake bigint;
  v_max_stake bigint;
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

  -- Stake limits are platform configuration (Super Admin), read live on every
  -- proposal — never a value baked into this function. They govern NEW
  -- proposals only: a proposal's terms are immutable once created, so a later
  -- change never invalidates one that is already PENDING (accept does not
  -- re-check them).
  select monetary_p2p_min_stake_cents, monetary_p2p_max_stake_cents
    into v_min_stake, v_max_stake
    from public.platform_settings where id = true;
  if p_stake < v_min_stake then
    raise exception 'stake_below_minimum';
  end if;
  if p_stake > v_max_stake then
    raise exception 'stake_above_maximum';
  end if;

  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  if not found then
    raise exception 'recipient_pick_not_found';
  end if;

  -- Account state is enforced here, not only by UI filtering: an inactive
  -- account can neither send money nor be the target of a proposal that
  -- would hold the sender's funds against someone who can never answer.
  select coalesce(is_active, false) into v_proposer_active from public.user_profiles where id = p_proposer_user_id;
  if not coalesce(v_proposer_active, false) then
    raise exception 'proposer_inactive';
  end if;
  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_recipient_pred.user_id;
  if not coalesce(v_recipient_active, false) then
    raise exception 'recipient_inactive';
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

  -- At most ONE active (COMMITTED) monetary Position per unordered user pair
  -- per Market. The pair is identified by its two Pick ids (one Pick per user
  -- per Market, so the Pick pair names the user pair AND the Market) put in
  -- canonical order with least()/greatest(), so Andre->Carlos and
  -- Carlos->Andre are the same pair. The check runs under a transaction-scoped
  -- advisory lock on that same key — the same lock accept_monetary_proposal()
  -- takes before it commits a Position — so a send cannot slip in between
  -- another proposal's check and its acceptance. The partial unique index
  -- monetary_positions_one_committed_pair is the backstop invariant.
  perform pg_advisory_xact_lock(hashtextextended(
    'monetary_pair:' || least(v_proposer_pred.id, v_recipient_pred.id)::text || ':' || greatest(v_proposer_pred.id, v_recipient_pred.id)::text, 0));
  if exists (
    select 1 from public.monetary_positions mp
    where mp.settlement_status = 'COMMITTED'
      and least(mp.proposer_prediction_id, mp.recipient_prediction_id) = least(v_proposer_pred.id, v_recipient_pred.id)
      and greatest(mp.proposer_prediction_id, mp.recipient_prediction_id) = greatest(v_proposer_pred.id, v_recipient_pred.id)
  ) then
    raise exception 'pair_already_has_position';
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
$function$;

CREATE OR REPLACE FUNCTION public.accept_monetary_proposal(p_proposal_id uuid, p_recipient_user_id uuid)
 RETURNS accept_monetary_proposal_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_proposer_active boolean;
  v_recipient_active boolean;
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

  -- Re-check account eligibility at acceptance time: an account can be
  -- deactivated between a proposal being sent and being accepted. Same
  -- resolution as any other invalidation — expire it and release the
  -- proposer's hold, so no funds stay reserved against an ineligible pair.
  select coalesce(is_active, false) into v_proposer_active from public.user_profiles where id = v_proposal.proposer_user_id;
  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_proposal.recipient_user_id;
  if not coalesce(v_proposer_active, false) or not coalesce(v_recipient_active, false) then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_ineligible_account')::public.accept_monetary_proposal_result;
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

  -- Exact-pair exclusivity, re-checked under the same advisory lock
  -- propose_money() uses, before any money moves: if this pair already has an
  -- active Position on this Market, this proposal cannot become a second one.
  -- Same resolution as any other invalidation — expire it and release the
  -- proposer's hold; nothing was reserved for the recipient yet.
  perform pg_advisory_xact_lock(hashtextextended(
    'monetary_pair:' || least(v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id)::text || ':' || greatest(v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id)::text, 0));
  if exists (
    select 1 from public.monetary_positions mp
    where mp.settlement_status = 'COMMITTED'
      and least(mp.proposer_prediction_id, mp.recipient_prediction_id) = least(v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id)
      and greatest(mp.proposer_prediction_id, mp.recipient_prediction_id) = greatest(v_proposal.proposer_prediction_id, v_proposal.recipient_prediction_id)
  ) then
    update public.monetary_proposals set status = 'EXPIRED', expired_at = now(), updated_at = now() where id = v_proposal.id returning * into v_result_proposal;
    perform public.release_reservation(v_proposal.proposer_reservation_id);
    return (v_result_proposal, null, 'rejected_pair_has_position')::public.accept_monetary_proposal_result;
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
$function$;

drop function public.update_monetary_settings(uuid, timestamp with time zone, boolean, integer, integer, integer);

create function public.update_monetary_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamp with time zone,
  p_monetary_p2p_enabled boolean,
  p_monetary_proposal_rate_limit_window_seconds integer,
  p_monetary_proposal_rate_limit_max_attempts integer,
  p_p2p_fee_bps integer,
  p_monetary_p2p_min_stake_cents bigint default null,
  p_monetary_p2p_max_stake_cents bigint default null
)
 returns admin_settings_update_result
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_min bigint;
  v_max bigint;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_before from public.platform_settings where id = true for update;
  if v_before.updated_at <> p_expected_updated_at then
    return (v_before, 'conflict')::public.admin_settings_update_result;
  end if;

  -- A null limit means "leave it as it is", so a caller that predates these
  -- settings (and sends only the original six arguments) keeps working and
  -- never resets them. Validated here as well as by the table CHECKs so the
  -- caller gets a typed error rather than a constraint-violation message.
  v_min := coalesce(p_monetary_p2p_min_stake_cents, v_before.monetary_p2p_min_stake_cents);
  v_max := coalesce(p_monetary_p2p_max_stake_cents, v_before.monetary_p2p_max_stake_cents);
  if v_min <= 0 or v_max <= 0 or v_max < v_min then
    raise exception 'invalid_stake_limits';
  end if;

  update public.platform_settings set
    monetary_p2p_enabled = p_monetary_p2p_enabled,
    monetary_proposal_rate_limit_window_seconds = p_monetary_proposal_rate_limit_window_seconds,
    monetary_proposal_rate_limit_max_attempts = p_monetary_proposal_rate_limit_max_attempts,
    p2p_fee_bps = p_p2p_fee_bps,
    monetary_p2p_min_stake_cents = v_min,
    monetary_p2p_max_stake_cents = v_max,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.monetary_p2p_updated', 'platform_settings', null,
    jsonb_build_object(
      'monetaryP2pEnabled', v_before.monetary_p2p_enabled,
      'monetaryProposalRateLimitWindowSeconds', v_before.monetary_proposal_rate_limit_window_seconds,
      'monetaryProposalRateLimitMaxAttempts', v_before.monetary_proposal_rate_limit_max_attempts,
      'p2pFeeBps', v_before.p2p_fee_bps,
      'monetaryP2pMinStakeCents', v_before.monetary_p2p_min_stake_cents,
      'monetaryP2pMaxStakeCents', v_before.monetary_p2p_max_stake_cents
    ),
    jsonb_build_object(
      'monetaryP2pEnabled', v_after.monetary_p2p_enabled,
      'monetaryProposalRateLimitWindowSeconds', v_after.monetary_proposal_rate_limit_window_seconds,
      'monetaryProposalRateLimitMaxAttempts', v_after.monetary_proposal_rate_limit_max_attempts,
      'p2pFeeBps', v_after.p2p_fee_bps,
      'monetaryP2pMinStakeCents', v_after.monetary_p2p_min_stake_cents,
      'monetaryP2pMaxStakeCents', v_after.monetary_p2p_max_stake_cents
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$function$;

revoke all on function public.update_monetary_settings(uuid, timestamp with time zone, boolean, integer, integer, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.update_monetary_settings(uuid, timestamp with time zone, boolean, integer, integer, integer, bigint, bigint) to service_role;
