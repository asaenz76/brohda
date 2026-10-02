-- Call BS exclusivity addendum — supersedes R7/R13.5's "one Pick may
-- belong to multiple simultaneously-ACCEPTED Challenges on the same
-- Market" behavior. The locked product rule is now: a user may
-- participate in at most ONE ACCEPTED Call BS Challenge per Market (as
-- challenger or recipient), while PENDING challenges remain fully
-- non-exclusive — many people may send Call BS to the same target, and
-- the target may hold many simultaneous PENDING challenges. Only
-- acceptance claims the exclusive pairing.
--
-- call_bs_enabled stays whatever it already is in this environment —
-- this migration does not touch that flag. Historical migrations 154/164
-- are not modified; this is a forward-only `create or replace`.

-- =====================================================================
-- call_bs(): one addition — reject a challenge whose recipient account
-- is inactive, closing the audit's "UI hides a deactivated user from
-- the discovery query, but the RPC itself never checked" gap. The
-- challenger is always the authenticated caller's own id (requireUser()
-- already guarantees a live session), so only the recipient needs this
-- new check; added anyway as cheap defense-in-depth for both sides.
-- =====================================================================
create or replace function public.call_bs(
  p_challenger_user_id uuid,
  p_recipient_prediction_id uuid
)
returns public.challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient_pred public.predictions;
  v_challenger_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_enabled boolean;
  v_result public.challenges;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  select coalesce(call_bs_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'call_bs_disabled';
  end if;

  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  if not found then
    raise exception 'recipient_pick_not_found';
  end if;

  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_recipient_pred.user_id;
  if not coalesce(v_recipient_active, false) then
    raise exception 'recipient_inactive';
  end if;

  select coalesce(is_active, false) into v_challenger_active from public.user_profiles where id = p_challenger_user_id;
  if not coalesce(v_challenger_active, false) then
    raise exception 'challenger_inactive';
  end if;

  -- The challenger's own Pick is looked up by (user, market) — never
  -- accepted as a client-supplied id (§9) — so it is structurally
  -- impossible for a client to submit someone else's Pick as "their own".
  select * into v_challenger_pred from public.predictions where user_id = p_challenger_user_id and market_id = v_recipient_pred.market_id;
  if not found then
    raise exception 'challenger_pick_not_found';
  end if;

  if v_challenger_pred.user_id = v_recipient_pred.user_id then
    raise exception 'self_challenge';
  end if;

  if v_challenger_pred.selected_outcome = v_recipient_pred.selected_outcome then
    raise exception 'picks_not_opposing';
  end if;

  if v_challenger_pred.lifecycle_state = 'GRADED' or v_recipient_pred.lifecycle_state = 'GRADED' then
    raise exception 'pick_already_graded';
  end if;

  -- Authoritative, live, in-transaction eligibility against the canonical
  -- Game — same join set_pick() itself uses, same read, same cutoff
  -- column.
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
    raise exception 'past_challenge_cutoff';
  end if;

  -- Deliberately NOT checking "is either side already exclusively paired
  -- on this Market" here — send semantics are unchanged (per this
  -- addendum's own §4): a PENDING challenge against an already-paired
  -- user is harmless (it can simply never be accepted — see
  -- accept_call_bs() below) and getMarketParticipants() already keeps
  -- the UI from offering this in the first place.
  begin
    insert into public.challenges (
      market_id, challenger_user_id, recipient_user_id,
      challenger_prediction_id, recipient_prediction_id,
      challenger_selection_snapshot, recipient_selection_snapshot
    ) values (
      v_recipient_pred.market_id, p_challenger_user_id, v_recipient_pred.user_id,
      v_challenger_pred.id, v_recipient_pred.id,
      v_challenger_pred.selected_outcome, v_recipient_pred.selected_outcome
    )
    returning * into v_result;
    return v_result;
  exception when unique_violation then
    -- challenges_one_pending_pair (§25-26): an identical or reverse
    -- pending Challenge between these same two Picks already exists.
    raise exception 'duplicate_pending_challenge';
  end;
end;
$$;

revoke all on function public.call_bs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.call_bs(uuid, uuid) to service_role;

-- =====================================================================
-- accept_call_bs(): the exclusivity enforcement itself.
--
-- Serialization strategy: two transaction-scoped Postgres advisory locks
-- (pg_advisory_xact_lock — auto-released at this function's own implicit
-- commit/rollback, never leaked past the RPC call), one per participant,
-- keyed on (market_id, user_id) via hashtextextended. Acquired in
-- deterministic ascending-user_id order — the SAME ordering discipline
-- this function already uses for its two Pick-row FOR UPDATE locks below,
-- just applied to a second, independent lock resource. Because every
-- call to this function sorts its own two keys the same globally
-- consistent way, no two concurrent calls can ever acquire their two
-- locks in opposite order relative to each other — the standard
-- total-ordering deadlock-prevention argument applies directly, and it
-- generalizes beyond just two competing calls (any cycle among N
-- concurrent calls would require the call holding the globally-smallest
-- still-contested key to be blocked waiting on a larger one it hasn't
-- yet tried to acquire, which is impossible under a per-call ascending
-- acquisition order).
--
-- Why advisory locks rather than a new table/unique index: the
-- exclusivity unit is (user_id, market_id), but a single `challenges` row
-- touches TWO users in two different columns — a plain partial unique
-- index on `challenges` itself cannot express "neither column's value may
-- repeat across any other ACCEPTED row for this market," and a
-- derived side table existing solely to hold that uniqueness constraint
-- is exactly the kind of schema expansion this addendum says to avoid
-- unless genuinely required. Holding both participants' advisory locks
-- across (a) the "is either side already paired" read and (b) this same
-- transaction's own ACCEPTED/EXPIRED writes makes that read-then-write
-- atomic against any other transaction that would need the same lock —
-- which is the actual race-safety property required, without a new
-- table.
-- =====================================================================
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

  -- Under the OLD rule, a pre-existing CHALLENGE_ACCEPTED lock on either
  -- Pick was explicitly tolerated (multiplicity was allowed). Under this
  -- addendum it no longer is: ANY existing lock on either Pick now means
  -- this Pick already belongs to a different ACCEPTED Challenge on this
  -- same Market (predictions are one-row-per-user-per-market, so a
  -- locked Pick here can only have been locked by a Challenge on THIS
  -- Market) — which the advisory-lock-protected check above should
  -- already have caught. This is deliberate defense-in-depth for the
  -- narrow window between that check and acquiring these specific row
  -- locks, not the primary enforcement mechanism.
  if v_challenger_pred.locked_at is not null or v_recipient_pred.locked_at is not null then
    if v_challenger_pred.lock_reason = 'CUTOFF' or v_recipient_pred.lock_reason = 'CUTOFF' then
      update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
      return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
    else
      update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
      return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
    end if;
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
