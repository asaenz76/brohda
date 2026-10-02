-- Call BS / monetary-lock compatibility (final hardening).
--
-- Locked product rule: Call BS and monetary P2P are separate layers. A Pick
-- locked solely because money was committed to it
-- (lock_reason = 'MONETARY_POSITION_ACCEPTED') must remain eligible for one
-- free accepted Call BS on the same Market. Before this migration,
-- accept_call_bs() treated ANY existing locked_at as "already paired", so
-- money-first silently blocked Call BS acceptance while Call BS-first still
-- allowed money (accept_monetary_proposal() tolerates any non-CUTOFF lock).
-- The UI never checked locked_at, so it offered a Call BS the RPC then
-- refused.
--
-- This is a forward-only `create or replace` of accept_call_bs(). Same
-- signature, same return type, same privileges: it only ever ACCEPTS
-- something the previous version rejected, so it is safe to apply before or
-- after the application deploy. No schema change — the single
-- locked_at/lock_reason pair is sufficient (see the comment inside).
-- Exclusivity (one ACCEPTED Call BS per user per Market) is unchanged and
-- still enforced by the conflict count under the two advisory locks.

create or replace function public.accept_call_bs(
  p_challenge_id uuid,
  p_recipient_user_id uuid
)
returns public.accept_call_bs_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.challenges;
  v_lower public.predictions;
  v_upper public.predictions;
  v_challenger_pred public.predictions;
  v_recipient_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_result public.challenges;
  v_first_user uuid;
  v_second_user uuid;
  v_conflict_count integer;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then
    raise exception 'challenge_not_found';
  end if;

  if v_challenge.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  if v_challenge.status <> 'PENDING' then
    return (v_challenge, 'not_pending')::public.accept_call_bs_result;
  end if;

  -- Deterministic advisory-lock ordering (see header comment above).
  if v_challenge.challenger_user_id < v_challenge.recipient_user_id then
    v_first_user := v_challenge.challenger_user_id;
    v_second_user := v_challenge.recipient_user_id;
  else
    v_first_user := v_challenge.recipient_user_id;
    v_second_user := v_challenge.challenger_user_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_challenge.market_id::text || ':' || v_first_user::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_challenge.market_id::text || ':' || v_second_user::text, 0));

  -- Re-check account eligibility at acceptance time too, not only at
  -- send time — an account can deactivate between a Challenge being sent
  -- and being accepted.
  select coalesce(is_active, false) into v_challenger_active from public.user_profiles where id = v_challenge.challenger_user_id;
  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_challenge.recipient_user_id;
  if not coalesce(v_challenger_active, false) or not coalesce(v_recipient_active, false) then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_ineligible_account')::public.accept_call_bs_result;
  end if;

  -- THE exclusivity check, now race-safe under the two advisory locks
  -- held above: is either participant already the challenger or
  -- recipient of a DIFFERENT, already-ACCEPTED Challenge on this same
  -- Market? If so, this acceptance cannot proceed — reusing EXPIRED
  -- (not a new status — see this migration's own header and the prior
  -- audit's §6 analysis: EXPIRED's existing column comment already
  -- covers "became unacceptable before acceptance" generically, and no
  -- CHECK constraint on the table requires anything beyond that for it).
  select count(*) into v_conflict_count
  from public.challenges
  where market_id = v_challenge.market_id
    and status = 'ACCEPTED'
    and id <> v_challenge.id
    and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
         or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  if v_conflict_count > 0 then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  select f.internal_status, f.scheduled_start_utc
    into v_fixture_status, v_scheduled_start
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_challenge.market_id;

  if not found then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  -- Deterministic ascending-id Pick-row lock order (unchanged from R7 —
  -- a second, independent lock resource from the advisory locks above,
  -- also internally ordered consistently, so no deadlock between the
  -- two lock types either).
  if v_challenge.challenger_prediction_id < v_challenge.recipient_prediction_id then
    select * into v_lower from public.predictions where id = v_challenge.challenger_prediction_id for update;
    select * into v_upper from public.predictions where id = v_challenge.recipient_prediction_id for update;
    v_challenger_pred := v_lower;
    v_recipient_pred := v_upper;
  else
    select * into v_lower from public.predictions where id = v_challenge.recipient_prediction_id for update;
    select * into v_upper from public.predictions where id = v_challenge.challenger_prediction_id for update;
    v_challenger_pred := v_upper;
    v_recipient_pred := v_lower;
  end if;

  -- Pick-lock interpretation (final hardening). `locked_at` alone does NOT
  -- mean "this Pick is unavailable for a free Call BS": a Pick can be
  -- immutable for three independent reasons, and only two of them speak
  -- to Call BS eligibility:
  --
  --   CUTOFF                      the Pick closed at kickoff cutoff, so no
  --                               new Call BS may be accepted on it.
  --   CHALLENGE_ACCEPTED          already belongs to a free Call BS pairing
  --                               on this Market. The advisory-lock-protected
  --                               conflict count above is the primary guard;
  --                               this is defense-in-depth for the narrow
  --                               window before the row locks were taken.
  --   MONETARY_POSITION_ACCEPTED  money is committed to the Pick. This is a
  --                               separate layer on top of the social
  --                               prediction and must NOT consume or block
  --                               the one free Call BS slot per user per
  --                               Market. The Pick is already immutable, so
  --                               nothing needs locking here.
  --
  -- predictions carries one locked_at/lock_reason pair (CHECK: both set or
  -- both null), so an existing lock is never overwritten below — the
  -- UPDATE only ever sets it while still null. A money-locked Pick keeps
  -- its MONETARY_POSITION_ACCEPTED reason, which is correct: the Pick is
  -- immutable either way, and the accepted Challenge row itself is the
  -- record of the Call BS pairing.
  if v_challenger_pred.lock_reason = 'CUTOFF' or v_recipient_pred.lock_reason = 'CUTOFF' then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  if v_challenger_pred.lock_reason = 'CHALLENGE_ACCEPTED' or v_recipient_pred.lock_reason = 'CHALLENGE_ACCEPTED' then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  -- Revalidate current reality against the Challenge's own immutable
  -- snapshot — a Pick edit since creation invalidates the specific
  -- disagreement this Challenge names.
  if v_challenger_pred.selected_outcome <> v_challenge.challenger_selection_snapshot
     or v_recipient_pred.selected_outcome <> v_challenge.recipient_selection_snapshot
     or v_challenger_pred.lifecycle_state = 'GRADED'
     or v_recipient_pred.lifecycle_state = 'GRADED'
  then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  update public.predictions
    set locked_at = now(), lock_reason = 'CHALLENGE_ACCEPTED', updated_at = now()
    where id in (v_challenger_pred.id, v_recipient_pred.id) and locked_at is null;

  update public.challenges set status = 'ACCEPTED', accepted_at = now(), updated_at = now()
    where id = v_challenge.id
    returning * into v_result;

  -- Cascade: every OTHER still-PENDING Challenge on this same Market
  -- involving either participant (as challenger or recipient) becomes
  -- non-actionable the instant this one is accepted — the two cannot
  -- both ever become ACCEPTED now that one of them has, and leaving them
  -- PENDING would show a stale, un-acceptable Accept button. Reuses
  -- EXPIRED, same reasoning as above. No notification is sent for this
  -- transition (§17 of the addendum — not useful to spam the displaced
  -- party; the UI's own fresh read of challenge state already reflects
  -- "no longer available").
  update public.challenges
    set status = 'EXPIRED', updated_at = now()
    where market_id = v_challenge.market_id
      and status = 'PENDING'
      and id <> v_challenge.id
      and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
           or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  return (v_result, 'accepted')::public.accept_call_bs_result;
end;
$$;

revoke all on function public.accept_call_bs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_call_bs(uuid, uuid) to service_role;
