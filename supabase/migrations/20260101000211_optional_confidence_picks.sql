-- Brohda 2.1, Milestone 1 — Pick commitment semantics.
--
-- Confidence becomes OPTIONAL again without weakening what it is worth once it is given:
--   * a Member may make a team Pick with no Confidence; it stays editable until T-10 (and until Call BS or Confidence locks it);
--   * attaching Confidence locks the TEAM and fixes the AMOUNT immediately and permanently (Option 1: no increase, decrease or removal);
--   * a Pick locked by an accepted Call BS may still receive Confidence until T-10 (the team is already locked);
--   * editing an editable Pick expires every PENDING Call BS on it (expiry_reason PICK_CHANGED) in the same transaction;
--   * ONE database rule decides what a Member may still do before the Game (T-10), read with clock_timestamp() AFTER the locks;
--   * every writer takes the same advisory locks in the same order: (Market, Member) sorted by Member -> Pick rows by id -> Call BS rows by id.
--
-- This migration is ADDITIVE and defaults to today's behaviour: the new switch (platform_settings.confidence_optional_picks_enabled) is OFF,
-- and with it off every redefined function behaves exactly as before. Nothing here deletes or rewrites a row, unlocks a historical Pick, clears
-- confidence_mandatory_since (its one-way trigger is untouched) or touches a settled stake or ledger entry. Rollback = switch it off; no down migration.
-- Era semantics (documented, not stored per row): a Pick created before confidence_mandatory_since is LEGACY; between that and
-- confidence_optional_first_enabled_at it is MANDATORY-ERA (it must have a stake); from confidence_optional_first_enabled_at on it is OPTIONAL-ERA
-- (an unstaked Pick is valid). CONFIDENCE_COMMITTED meant "final" under the mandatory contract and means "Confidence committed the team" under 2.1.
-- T-10 (platform_settings.pick_lock_minutes_before_kickoff) is Brohda's ONLY Member prediction deadline: there is no T-5.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. The policy: an explicit switch plus a write-once "first enabled" instant
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column confidence_optional_picks_enabled boolean not null default false,
  add column confidence_optional_first_enabled_at timestamptz,
  add column confidence_two_step_composer_enabled boolean not null default false;
comment on column public.platform_settings.confidence_two_step_composer_enabled is
  'Brohda 2.1 UI flag: show the two-step composer (choose a team, then optionally "How confident are you?") instead of the one-step composer. Takes effect only while confidence_optional_picks_enabled is also true; independent of it, so the UI can be reverted without touching Picks. Switch only through admin_set_confidence_two_step_composer.';
comment on column public.platform_settings.confidence_optional_picks_enabled is
  'Brohda 2.1: when true a Pick may exist without Confidence (editable until T-10; attaching Confidence locks the team and fixes the amount). When false the mandatory-Confidence contract applies exactly as before. A reversible operational switch; turn it on only through admin_set_confidence_optional_picks.';
comment on column public.platform_settings.confidence_optional_first_enabled_at is
  'The instant optional Picks were FIRST enabled. Write-once: set automatically the first time the switch becomes true, never changed and never cleared (switching optional Picks off later keeps it). Separates MANDATORY-ERA Picks (before) from OPTIONAL-ERA Picks (at or after) in reconciliation and diagnostics.';

create or replace function public.confidence_optional_policy_guard()
returns trigger
language plpgsql
as $$
begin
  if old.confidence_optional_first_enabled_at is not null and new.confidence_optional_first_enabled_at is distinct from old.confidence_optional_first_enabled_at then
    raise exception 'confidence_optional_first_enabled_at is write-once';
  end if;
  if new.confidence_optional_picks_enabled and new.confidence_optional_first_enabled_at is null then
    new.confidence_optional_first_enabled_at := now();
  end if;
  if old.confidence_optional_first_enabled_at is null and new.confidence_optional_first_enabled_at is not null and new.confidence_optional_first_enabled_at is distinct from now() then
    raise exception 'confidence_optional_first_enabled_at can only be set to the moment optional Picks are first enabled';
  end if;
  return new;
end;
$$;
create trigger platform_settings_confidence_optional_policy before update of confidence_optional_picks_enabled, confidence_optional_first_enabled_at on public.platform_settings
  for each row execute function public.confidence_optional_policy_guard();
revoke all on function public.confidence_optional_policy_guard() from public, anon, authenticated, service_role;

-- The audited activation path (Super Admin; idempotent; needs Confidence and Confidence-backed Picks on). Direct writes are not the way to switch it.
create or replace function public.admin_set_confidence_optional_picks(p_admin_id uuid, p_enabled boolean)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  perform public.require_super_admin(p_admin_id);
  if p_enabled is null then raise exception 'invalid_enabled'; end if;
  select * into v_before from public.platform_settings where id = true for update;
  if v_before.confidence_optional_picks_enabled = p_enabled then
    return v_before;
  end if;
  if p_enabled and (v_before.confidence_enabled is not true or v_before.confidence_backed_picks_enabled is not true) then
    raise exception 'optional_picks_requires_confidence_on';
  end if;
  update public.platform_settings set confidence_optional_picks_enabled = p_enabled, updated_at = now(), updated_by = p_admin_id where id = true returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.confidence_optional_picks_updated', 'platform_settings', null,
      jsonb_build_object('confidence_optional_picks_enabled', v_before.confidence_optional_picks_enabled, 'confidence_optional_first_enabled_at', v_before.confidence_optional_first_enabled_at),
      jsonb_build_object('confidence_optional_picks_enabled', v_after.confidence_optional_picks_enabled, 'confidence_optional_first_enabled_at', v_after.confidence_optional_first_enabled_at));
  return v_after;
end;
$$;
revoke all on function public.admin_set_confidence_optional_picks(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_confidence_optional_picks(uuid, boolean) to service_role;

-- The UI flag has its own audited switch (Super Admin, idempotent): it changes what Members see, never what the database allows.
create or replace function public.admin_set_confidence_two_step_composer(p_admin_id uuid, p_enabled boolean)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  perform public.require_super_admin(p_admin_id);
  if p_enabled is null then raise exception 'invalid_enabled'; end if;
  select * into v_before from public.platform_settings where id = true for update;
  if v_before.confidence_two_step_composer_enabled = p_enabled then
    return v_before;
  end if;
  update public.platform_settings set confidence_two_step_composer_enabled = p_enabled, updated_at = now(), updated_by = p_admin_id where id = true returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.confidence_two_step_composer_updated', 'platform_settings', null,
      jsonb_build_object('confidence_two_step_composer_enabled', v_before.confidence_two_step_composer_enabled),
      jsonb_build_object('confidence_two_step_composer_enabled', v_after.confidence_two_step_composer_enabled));
  return v_after;
end;
$$;
revoke all on function public.admin_set_confidence_two_step_composer(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_confidence_two_step_composer(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. One authoritative T-10 rule
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The ONE formula for the deadline (kickoff minus the configured lock window). Everything that needs "when does this Game stop taking Picks" reads it here.
create or replace function public.pick_lock_deadline(p_scheduled_start timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select p_scheduled_start - (coalesce((select pick_lock_minutes_before_kickoff from public.platform_settings where id = true), 10) || ' minutes')::interval;
$$;
revoke all on function public.pick_lock_deadline(timestamptz) from public, anon, authenticated;
grant execute on function public.pick_lock_deadline(timestamptz) to service_role;

-- The existing timing abstraction, now built on the one formula (same signature and result as before).
create or replace function public.pick_market_timing(p_market_id uuid)
returns table (fixture_status public.fixture_internal_status, scheduled_start timestamptz, effective_lock_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select f.internal_status, f.scheduled_start_utc, public.pick_lock_deadline(f.scheduled_start_utc)
  from public.markets m
  join public.fixtures f on f.id = m.fixture_id
  where m.id = p_market_id;
$$;

-- "May a Member still act on this Market?" — evaluated with clock_timestamp() (the real time of the call, NOT the transaction start), so a call that
-- waited for a lock and woke up after T-10 is refused. Callers invoke it AFTER taking their locks. Returns no row for an unknown Market.
create or replace function public.pick_action_window(p_market_id uuid)
returns table (is_open boolean, closed_reason text, fixture_status public.fixture_internal_status, scheduled_start timestamptz, effective_lock_at timestamptz, market_status text)
language sql
volatile
security definer
set search_path = public
as $$
  select t.fixture_status = 'NOT_STARTED' and clock_timestamp() < t.effective_lock_at,
         case when t.fixture_status <> 'NOT_STARTED' then 'game_started' when clock_timestamp() >= t.effective_lock_at then 'past_deadline' end,
         t.fixture_status, t.scheduled_start, t.effective_lock_at, m.status::text
  from public.pick_market_timing(p_market_id) t
  join public.markets m on m.id = p_market_id;
$$;
revoke all on function public.pick_action_window(uuid) from public, anon, authenticated;
grant execute on function public.pick_action_window(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. One lock contract
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Advisory locks per (Market, Member), the Members taken in sorted order. THE canonical key is  market_id || ':' || member_id.  Every writer that changes a
-- Pick, a stake or a Call BS calls this FIRST; only then does it lock Pick rows (by id) and Call BS rows (by id). A holder of a single (Market, Member) lock never
-- waits on another advisory lock, so no cycle between writers can form.
create or replace function public.lock_market_members(p_market_id uuid, p_user_a uuid, p_user_b uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first uuid;
  v_second uuid;
begin
  if p_user_b is null or p_user_b = p_user_a then
    perform pg_advisory_xact_lock(hashtextextended(p_market_id::text || ':' || p_user_a::text, 0));
    return;
  end if;
  if p_user_a < p_user_b then v_first := p_user_a; v_second := p_user_b; else v_first := p_user_b; v_second := p_user_a; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_market_id::text || ':' || v_first::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_market_id::text || ':' || v_second::text, 0));
end;
$$;
revoke all on function public.lock_market_members(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lock_market_members(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. A Pick edit that ends a Call BS: the reason, and the result type that reports it
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.challenges drop constraint challenges_expiry_reason_check;
alter table public.challenges add constraint challenges_expiry_reason_check
  check (expiry_reason in ('NO_RESPONSE', 'GAME_OR_MARKET_CANCELLED', 'SYSTEM_INVALIDATED', 'COMPETING_CHALLENGE_RESOLVED', 'ACCOUNT_STATE_CHANGE', 'RELATIONSHIP_BLOCKED', 'OTHER_SYSTEM_REASON', 'PICK_CHANGED'));
comment on column public.challenges.expiry_reason is 'Why a Call BS ended without being answered. Set exactly when status = EXPIRED. Only NO_RESPONSE (nobody answered in time) can ever count against a Member; every other reason is system- or relationship-driven. PICK_CHANGED: one of the two Members changed their (editable) Pick, so the pair no longer opposes — shown as "Challenge cancelled because the Pick changed".';

-- set_pick now also reports which Call BS challenges the edit cancelled (null/empty when none), so the caller can notify the other participant after commit.
alter type public.set_pick_result add attribute cancelled_challenge_ids uuid[];

-- The notification for a cancelled challenge is sent at most once per recipient.
create unique index notifications_call_bs_cancelled_once on public.notifications (user_id, challenge_id) where type = 'CALL_BS_CANCELLED';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. set_pick: optional Picks, the one timing rule, the lock order, and cancelling the Call BS an edit invalidates
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.set_pick(p_user_id uuid, p_market_id uuid, p_selected_outcome text, p_yes_probability numeric, p_no_probability numeric, p_market_question text, p_market_close_at timestamp with time zone, p_market_status text, p_idempotency_key text)
returns set_pick_result
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_replay public.predictions;
  v_existing public.predictions;
  v_w record;
  v_result public.predictions;
  v_s public.platform_settings;
  v_revision_id uuid;
  v_challenge record;
  v_cancelled uuid[] := '{}';
begin
  if p_selected_outcome not in ('YES', 'NO') then
    raise exception 'invalid_selected_outcome';
  end if;

  -- After the mandatory cutover a Pick exists only together with its Confidence — unless optional Picks are switched on. Then one team tap may create a Pick on its own.
  -- (The atomic composer path, create_confidence_prediction, sets brohda.confidence_composer for its own transaction and is always allowed.)
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_mandatory_since is not null and v_s.confidence_optional_picks_enabled is not true and coalesce(current_setting('brohda.confidence_composer', true), 'off') <> 'on' then
    return (null, 'rejected_backing_required', null)::public.set_pick_result;
  end if;

  -- Lock contract step 1: the (Market, Member) advisory lock. Everything below — the deadline included — is decided after it, at the time the lock was actually obtained.
  perform public.lock_market_members(p_market_id, p_user_id);

  select * into v_replay from public.predictions where idempotency_key = p_idempotency_key;
  if found then
    return (v_replay, 'replayed', null)::public.set_pick_result;
  end if;

  select * into v_w from public.pick_action_window(p_market_id);
  if not found then
    raise exception 'market_not_found';
  end if;

  -- Lock contract step 2: the Pick row.
  select * into v_existing from public.predictions where user_id = p_user_id and market_id = p_market_id for update;

  if not found then
    if v_w.fixture_status <> 'NOT_STARTED' then
      return (null, 'rejected_game_closed', null)::public.set_pick_result;
    end if;
    if not v_w.is_open then
      return (null, 'rejected_cutoff', null)::public.set_pick_result;
    end if;

    begin
      insert into public.predictions (
        user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot,
        market_question_snapshot, market_close_at_snapshot, market_status_snapshot, idempotency_key
      ) values (
        p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability,
        p_market_question, p_market_close_at, p_market_status, p_idempotency_key
      )
      returning * into v_result;
      return (v_result, 'created', null)::public.set_pick_result;
    exception when unique_violation then
      return public.set_pick(p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability, p_market_question, p_market_close_at, p_market_status, p_idempotency_key);
    end;
  end if;

  -- Locked by anything (Confidence, an accepted Call BS, the deadline written earlier) or graded: never editable.
  if v_existing.locked_at is not null or v_existing.lifecycle_state = 'GRADED'
     or exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = v_existing.id)
     or exists (select 1 from public.challenges c where c.status = 'ACCEPTED' and (c.challenger_prediction_id = v_existing.id or c.recipient_prediction_id = v_existing.id)) then
    return (v_existing, 'rejected_locked', null)::public.set_pick_result;
  end if;

  if not v_w.is_open then
    update public.predictions set locked_at = least(clock_timestamp(), v_w.effective_lock_at), lock_reason = 'CUTOFF', updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    return (v_result, 'rejected_cutoff', null)::public.set_pick_result;
  end if;

  if v_existing.selected_outcome = p_selected_outcome then
    return (v_existing, 'unchanged', null)::public.set_pick_result;
  end if;

  insert into public.prediction_revisions (
    prediction_id, user_id, previous_selected_outcome, previous_probability_snapshot, new_selected_outcome, new_probability_snapshot
  ) values (
    v_existing.id, p_user_id, v_existing.selected_outcome,
    case when v_existing.selected_outcome = 'YES' then v_existing.yes_probability_snapshot else v_existing.no_probability_snapshot end,
    p_selected_outcome,
    case when p_selected_outcome = 'YES' then p_yes_probability else p_no_probability end
  ) returning id into v_revision_id;

  update public.predictions set
    selected_outcome = p_selected_outcome,
    yes_probability_snapshot = p_yes_probability,
    no_probability_snapshot = p_no_probability,
    market_question_snapshot = p_market_question,
    market_close_at_snapshot = p_market_close_at,
    market_status_snapshot = p_market_status,
    updated_at = now()
  where id = v_existing.id
  returning * into v_result;

  -- Lock contract step 3: the Call BS rows on this Pick, by id. Outcomes are binary, so once this Pick changes side every PENDING challenge on it no longer opposes: all of them end here,
  -- in this transaction, as EXPIRED / PICK_CHANGED. (ACCEPTED ones never reach this point: an accepted Call BS locks the Pick above.)
  for v_challenge in
    select c.* from public.challenges c
    where c.status = 'PENDING' and (c.challenger_prediction_id = v_existing.id or c.recipient_prediction_id = v_existing.id)
    order by c.id for update
  loop
    update public.challenges set status = 'EXPIRED', expiry_reason = 'PICK_CHANGED', updated_at = now() where id = v_challenge.id;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason, before, after)
      values (p_user_id, 'call_bs.pick_changed', 'challenge', v_challenge.id::text, 'PICK_CHANGED',
        jsonb_build_object('status', 'PENDING', 'challengerPredictionId', v_challenge.challenger_prediction_id, 'recipientPredictionId', v_challenge.recipient_prediction_id,
          'challengerUserId', v_challenge.challenger_user_id, 'recipientUserId', v_challenge.recipient_user_id, 'previousSelection', v_existing.selected_outcome),
        jsonb_build_object('status', 'EXPIRED', 'expiryReason', 'PICK_CHANGED', 'editedPredictionId', v_existing.id, 'editedMemberId', p_user_id,
          'newSelection', p_selected_outcome, 'revisionId', v_revision_id, 'marketId', p_market_id));
    v_cancelled := array_append(v_cancelled, v_challenge.id);
  end loop;

  return (v_result, 'updated', v_cancelled)::public.set_pick_result;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. The mandatory-stake invariant: unchanged unless optional Picks are switched on
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_pick_requires_stake()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz;
  v_optional boolean;
begin
  select confidence_mandatory_since, confidence_optional_picks_enabled into v_since, v_optional from public.platform_settings where id = true;
  if v_since is not null and new.created_at >= v_since and v_optional is not true and not exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = new.id) then
    raise exception 'a Pick cannot exist without Confidence behind it';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 7. Atomic Pick + Confidence: same behaviour, the canonical lock and the one timing rule
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.create_confidence_prediction(
  p_user_id uuid, p_market_id uuid, p_selected_outcome text, p_amount integer, p_yes_probability numeric, p_no_probability numeric,
  p_market_question text, p_market_close_at timestamp with time zone, p_market_status text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_entry public.confidence_ledger_entries;
  v_prior_stake public.confidence_prediction_stakes;
  v_prior_pred public.predictions;
  v_w record;
  v_existing public.predictions;
  v_existing_stake public.confidence_prediction_stakes;
  v_account public.confidence_accounts;
  v_pick public.set_pick_result;
  v_pred public.predictions;
  v_stake public.confidence_prediction_stakes;
  v_fixture uuid;
begin
  if p_selected_outcome not in ('YES', 'NO') then raise exception 'invalid_selected_outcome'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;

  select * into v_s from public.platform_settings where id = true;
  -- Predictions with Confidence exist only with Confidence on: with either switch off nothing can be created.
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_user_id) then return jsonb_build_object('outcome', 'ineligible'); end if;

  -- One request per (Market, Member) at a time, under the canonical key: a double tap waits here and then finds the first one's result (a replay).
  perform public.lock_market_members(p_market_id, p_user_id);

  select * into v_entry from public.confidence_ledger_entries where member_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_prior_stake from public.confidence_prediction_stakes where id = v_entry.stake_id;
    select * into v_prior_pred from public.predictions where id = v_prior_stake.prediction_id;
    if v_prior_pred.market_id is distinct from p_market_id then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    select * into v_account from public.confidence_accounts where member_id = p_user_id;
    return jsonb_build_object('outcome', 'created', 'replay', true, 'predictionId', v_prior_pred.id, 'stakeId', v_prior_stake.id, 'selectedOutcome', v_prior_pred.selected_outcome,
      'amount', v_prior_stake.amount, 'available', v_account.available, 'reserved', v_account.reserved, 'total', v_account.available + v_account.reserved);
  end if;

  if p_amount is null or p_amount < 1 or not (p_amount = any (v_s.confidence_allowed_stakes)) then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  -- The canonical deadline, evaluated NOW against authoritative Game state — never the client — after the lock.
  select * into v_w from public.pick_action_window(p_market_id);
  if not found then raise exception 'market_not_found'; end if;
  if v_w.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('outcome', 'game_started'); end if;
  if not v_w.is_open then return jsonb_build_object('outcome', 'past_deadline'); end if;

  select * into v_existing from public.predictions where user_id = p_user_id and market_id = p_market_id for update;
  if found then
    select * into v_existing_stake from public.confidence_prediction_stakes where prediction_id = v_existing.id;
    if found then
      return jsonb_build_object('outcome', 'already_predicted', 'predictionId', v_existing.id, 'selectedOutcome', v_existing.selected_outcome, 'amount', v_existing_stake.amount);
    end if;
    if v_existing.locked_at is not null or v_existing.lifecycle_state <> 'PENDING' then
      return jsonb_build_object('outcome', 'pick_locked', 'predictionId', v_existing.id, 'selectedOutcome', v_existing.selected_outcome);
    end if;
  end if;

  perform public.confidence_bootstrap_member(p_user_id);
  select * into v_account from public.confidence_accounts where member_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;
  -- Available, never total: Confidence already behind another prediction is not spendable twice.
  if v_account.available < p_amount then return jsonb_build_object('outcome', 'insufficient', 'available', v_account.available); end if;

  perform set_config('brohda.confidence_composer', 'on', true);
  v_pick := public.set_pick(p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability, p_market_question, p_market_close_at, p_market_status, p_idempotency_key);
  perform set_config('brohda.confidence_composer', 'off', true);
  if v_pick.outcome not in ('created', 'updated', 'unchanged') then
    -- Nothing was created (a refused attempt may have recorded the Game's own cutoff lock on an old open Pick, which is correct).
    return jsonb_build_object('outcome', case v_pick.outcome
      when 'rejected_game_closed' then 'game_started' when 'rejected_cutoff' then 'past_deadline' when 'rejected_locked' then 'pick_locked'
      when 'replayed' then 'idempotency_conflict' else 'rejected' end);
  end if;
  v_pred := v_pick.prediction;

  select m.fixture_id into v_fixture from public.markets m where m.id = p_market_id;
  insert into public.confidence_prediction_stakes (member_id, prediction_id, market_id, fixture_id, selected_outcome, amount, allowed_stakes_snapshot)
    values (p_user_id, v_pred.id, p_market_id, v_fixture, v_pred.selected_outcome, p_amount, v_s.confidence_allowed_stakes)
    returning * into v_stake;
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, stake_id, idempotency_key, metadata)
    values (p_user_id, 'PREDICTION_RESERVE', -p_amount, p_amount, v_stake.id, p_idempotency_key, jsonb_build_object('predictionId', v_pred.id))
    returning * into v_entry;
  -- Confidence commits the team: the Pick is locked from this moment (a Pick locked earlier by something else keeps its own reason).
  update public.predictions set locked_at = coalesce(locked_at, now()), lock_reason = coalesce(lock_reason, 'CONFIDENCE_COMMITTED'), updated_at = now() where id = v_pred.id;

  return jsonb_build_object('outcome', 'created', 'predictionId', v_pred.id, 'stakeId', v_stake.id, 'selectedOutcome', v_pred.selected_outcome, 'amount', p_amount,
    'available', v_entry.available_after, 'reserved', v_entry.reserved_after, 'total', v_entry.available_after + v_entry.reserved_after,
    'cancelledChallengeIds', to_jsonb(coalesce(v_pick.cancelled_challenge_ids, '{}'::uuid[])));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 8. Attaching Confidence to an existing Pick (revived under optional Picks)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Before T-10, to an ungraded, unstaked Pick of the Member's own — including one an accepted Call BS has already locked (the team does not change; Confidence is
-- independent of Call BS). Stake + reserve + lock in one transaction; the amount is fixed from this moment (a second attach is refused: one stake per Pick, ever).
create or replace function public.confidence_attach_stake(p_member_id uuid, p_prediction_id uuid, p_amount integer, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_pred public.predictions;
  v_market uuid;
  v_account public.confidence_accounts;
  v_prior public.confidence_ledger_entries;
  v_prior_stake public.confidence_prediction_stakes;
  v_w record;
  v_fixture uuid;
  v_stake public.confidence_prediction_stakes;
  v_entry public.confidence_ledger_entries;
begin
  select * into v_s from public.platform_settings where id = true;
  -- Retired only while the mandatory contract applies on its own: with optional Picks on, a Pick can exist first and be backed afterwards.
  if v_s.confidence_mandatory_since is not null and v_s.confidence_optional_picks_enabled is not true then return jsonb_build_object('outcome', 'retired'); end if;
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('outcome', 'ineligible'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;
  if p_amount is null or p_amount < 1 then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  -- Identify the Market without a lock, take the canonical lock, then read the Pick under its row lock.
  select market_id into v_market from public.predictions where id = p_prediction_id and user_id = p_member_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  perform public.lock_market_members(v_market, p_member_id);
  select * into v_pred from public.predictions where id = p_prediction_id and user_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_prior_stake from public.confidence_prediction_stakes where id = v_prior.stake_id;
    if v_prior_stake.prediction_id is distinct from p_prediction_id then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    return jsonb_build_object('outcome', 'attached', 'replay', true, 'stakeId', v_prior_stake.id, 'amount', v_prior_stake.amount);
  end if;

  if exists (select 1 from public.confidence_prediction_stakes where prediction_id = p_prediction_id) then return jsonb_build_object('outcome', 'already_backed'); end if;
  if v_pred.lifecycle_state <> 'PENDING' then return jsonb_build_object('outcome', 'pick_graded'); end if;

  select * into v_w from public.pick_action_window(v_market);
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_w.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('outcome', 'game_started'); end if;
  if not v_w.is_open or v_pred.lock_reason = 'CUTOFF' then return jsonb_build_object('outcome', 'past_deadline'); end if;

  if not (p_amount = any (v_s.confidence_allowed_stakes)) then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  perform public.confidence_bootstrap_member(p_member_id);
  select * into v_account from public.confidence_accounts where member_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;
  if v_account.available < p_amount then return jsonb_build_object('outcome', 'insufficient', 'available', v_account.available); end if;

  select m.fixture_id into v_fixture from public.markets m where m.id = v_market;
  insert into public.confidence_prediction_stakes (member_id, prediction_id, market_id, fixture_id, selected_outcome, amount, allowed_stakes_snapshot)
    values (p_member_id, p_prediction_id, v_market, v_fixture, v_pred.selected_outcome, p_amount, v_s.confidence_allowed_stakes)
    returning * into v_stake;
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, stake_id, idempotency_key, metadata)
    values (p_member_id, 'PREDICTION_RESERVE', -p_amount, p_amount, v_stake.id, p_idempotency_key, jsonb_build_object('predictionId', p_prediction_id))
    returning * into v_entry;
  -- Confidence commits the team. A Pick an accepted Call BS already locked keeps that reason (prediction_lock_reasons reports both: the stake is what adds CONFIDENCE_COMMITTED).
  update public.predictions set locked_at = coalesce(locked_at, now()), lock_reason = coalesce(lock_reason, 'CONFIDENCE_COMMITTED'), updated_at = now() where id = p_prediction_id;

  return jsonb_build_object('outcome', 'attached', 'stakeId', v_stake.id, 'amount', p_amount, 'selectedOutcome', v_pred.selected_outcome, 'available', v_entry.available_after, 'reserved', v_entry.reserved_after, 'total', v_entry.available_after + v_entry.reserved_after);
end;
$$;
revoke all on function public.confidence_attach_stake(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.confidence_attach_stake(uuid, uuid, integer, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 9. Call BS: create and accept under the canonical lock order and the one timing rule; the sweep on the one deadline formula
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.call_bs(p_challenger_user_id uuid, p_recipient_prediction_id uuid)
returns challenges
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_recipient_pred public.predictions;
  v_challenger_pred public.predictions;
  v_challenger_pred_id uuid;
  v_w record;
  v_enabled boolean;
  v_result public.challenges;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  select coalesce(call_bs_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'call_bs_disabled';
  end if;

  -- Identify both Members and the Market WITHOUT locks, then take the canonical locks before reading either Pick, so a Pick being edited cannot be challenged from a stale selection.
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

  if public.members_blocked(p_challenger_user_id, v_recipient_pred.user_id) then
    raise exception 'relationship_blocked';
  end if;

  select id into v_challenger_pred_id from public.predictions where user_id = p_challenger_user_id and market_id = v_recipient_pred.market_id;
  if not found then
    raise exception 'challenger_pick_not_found';
  end if;

  if p_challenger_user_id = v_recipient_pred.user_id then
    raise exception 'self_challenge';
  end if;

  perform public.lock_market_members(v_recipient_pred.market_id, p_challenger_user_id, v_recipient_pred.user_id);
  perform 1 from public.predictions where id in (v_challenger_pred_id, v_recipient_pred.id) order by id for update;

  -- Re-read under the locks: this is what the challenge is created from.
  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  select * into v_challenger_pred from public.predictions where id = v_challenger_pred_id;

  if v_challenger_pred.selected_outcome = v_recipient_pred.selected_outcome then
    raise exception 'picks_not_opposing';
  end if;

  if v_challenger_pred.lifecycle_state = 'GRADED' or v_recipient_pred.lifecycle_state = 'GRADED' then
    raise exception 'pick_already_graded';
  end if;

  select * into v_w from public.pick_action_window(v_recipient_pred.market_id);
  if not found then
    raise exception 'market_not_found';
  end if;

  if not v_w.is_open then
    raise exception 'past_challenge_cutoff';
  end if;

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
    raise exception 'duplicate_pending_challenge';
  end;
end;
$function$;

create or replace function public.accept_call_bs(p_challenge_id uuid, p_recipient_user_id uuid)
returns accept_call_bs_result
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_challenge public.challenges;
  v_challenger_pred public.predictions;
  v_recipient_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_market_status text;
  v_scheduled_start timestamptz;
  v_result public.challenges;
  v_conflict_count integer;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  -- Lock contract: identify the challenge WITHOUT its row lock, then (1) the advisory locks, (2) both Pick rows by id, (3) the challenge row — and revalidate everything.
  select * into v_challenge from public.challenges where id = p_challenge_id;
  if not found then
    raise exception 'challenge_not_found';
  end if;

  if v_challenge.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  perform public.lock_market_members(v_challenge.market_id, v_challenge.challenger_user_id, v_challenge.recipient_user_id);
  perform 1 from public.predictions where id in (v_challenge.challenger_prediction_id, v_challenge.recipient_prediction_id) order by id for update;
  select * into v_challenge from public.challenges where id = p_challenge_id for update;

  if v_challenge.status <> 'PENDING' then
    return (v_challenge, 'not_pending')::public.accept_call_bs_result;
  end if;

  select coalesce(is_active, false) into v_challenger_active from public.user_profiles where id = v_challenge.challenger_user_id;
  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_challenge.recipient_user_id;
  if not coalesce(v_challenger_active, false) or not coalesce(v_recipient_active, false) then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'ACCOUNT_STATE_CHANGE', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_ineligible_account')::public.accept_call_bs_result;
  end if;

  -- A block between the pair ends the challenge (the answer is the same neutral "no longer available" an invalidated one gets, so it reveals nothing about who blocked whom).
  if public.members_blocked(v_challenge.challenger_user_id, v_challenge.recipient_user_id) then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'RELATIONSHIP_BLOCKED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  select count(*) into v_conflict_count
  from public.challenges
  where market_id = v_challenge.market_id
    and status = 'ACCEPTED'
    and id <> v_challenge.id
    and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
         or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  if v_conflict_count > 0 then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  select f.internal_status, f.scheduled_start_utc, m.status::text
    into v_fixture_status, v_scheduled_start, v_market_status
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_challenge.market_id;

  if not found then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'SYSTEM_INVALIDATED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  -- The one deadline, read now that every lock is held.
  if clock_timestamp() >= public.pick_lock_deadline(v_scheduled_start) or v_fixture_status <> 'NOT_STARTED' then
    update public.challenges set status = 'EXPIRED', expiry_reason = public.challenge_game_expiry_reason(v_fixture_status, v_market_status), updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  select * into v_challenger_pred from public.predictions where id = v_challenge.challenger_prediction_id;
  select * into v_recipient_pred from public.predictions where id = v_challenge.recipient_prediction_id;

  -- (Pick-lock interpretation unchanged: CUTOFF closes the Pick; CHALLENGE_ACCEPTED means it already belongs to a free pairing; MONETARY_POSITION_ACCEPTED does not block a free Call BS.)
  if v_challenger_pred.lock_reason = 'CUTOFF' or v_recipient_pred.lock_reason = 'CUTOFF' then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'NO_RESPONSE', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  if v_challenger_pred.lock_reason = 'CHALLENGE_ACCEPTED' or v_recipient_pred.lock_reason = 'CHALLENGE_ACCEPTED' then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  if v_challenger_pred.selected_outcome <> v_challenge.challenger_selection_snapshot
     or v_recipient_pred.selected_outcome <> v_challenge.recipient_selection_snapshot
     or v_challenger_pred.selected_outcome = v_recipient_pred.selected_outcome
     or v_challenger_pred.lifecycle_state = 'GRADED'
     or v_recipient_pred.lifecycle_state = 'GRADED'
  then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'SYSTEM_INVALIDATED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  update public.predictions
    set locked_at = now(), lock_reason = 'CHALLENGE_ACCEPTED', updated_at = now()
    where id in (v_challenger_pred.id, v_recipient_pred.id) and locked_at is null;

  update public.challenges set status = 'ACCEPTED', accepted_at = now(), updated_at = now()
    where id = v_challenge.id
    returning * into v_result;

  -- Cascade: every OTHER still-PENDING Challenge on this Market involving either participant can no longer be accepted — a competing Call BS was resolved first, which is not anyone's silence.
  update public.challenges
    set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now()
    where market_id = v_challenge.market_id
      and status = 'PENDING'
      and id <> v_challenge.id
      and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
           or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  return (v_result, 'accepted')::public.accept_call_bs_result;
end;
$function$;

-- The sweep: a PENDING Call BS that can no longer be accepted. WHY it ran out is decided by the one classifier; WHEN, by the one deadline.
create or replace function public.expire_stale_challenges(p_limit integer default 200)
returns setof challenges
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  return query
  with stale as (
    select c.id, f.internal_status as fixture_status, m.status::text as market_status
    from public.challenges c
    join public.markets m on m.id = c.market_id
    join public.fixtures f on f.id = m.fixture_id
    where c.status = 'PENDING'
      and (
        clock_timestamp() >= public.pick_lock_deadline(f.scheduled_start_utc)
        or f.internal_status <> 'NOT_STARTED'
        or m.status <> 'ACTIVE'
      )
    order by c.created_at
    limit greatest(coalesce(p_limit, 200), 1)
    for update of c skip locked
  )
  update public.challenges c
    set status = 'EXPIRED', expiry_reason = public.challenge_game_expiry_reason(stale.fixture_status, stale.market_status), updated_at = now()
    from stale
    where c.id = stale.id and c.status = 'PENDING'
    returning c.*;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 10. Cancellation notifications: the ones still owed (reconciliation for best-effort delivery)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- A challenge cancelled because a Pick changed owes ONE notification to the participant who did NOT make the change (the editor is recorded in the audit row).
create or replace function public.call_bs_cancellations_awaiting_notification(p_limit integer default 100, p_since interval default interval '7 days')
returns table (challenge_id uuid, notify_user_id uuid, market_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         case when a.actor_id = c.challenger_user_id then c.recipient_user_id else c.challenger_user_id end,
         c.market_id
  from public.challenges c
  join public.audit_logs a on a.action = 'call_bs.pick_changed' and a.entity_type = 'challenge' and a.entity_id = c.id::text
  where c.status = 'EXPIRED' and c.expiry_reason = 'PICK_CHANGED'
    and c.updated_at > now() - coalesce(p_since, interval '7 days')
    and not exists (select 1 from public.notifications n where n.challenge_id = c.id and n.type = 'CALL_BS_CANCELLED'
                    and n.user_id = case when a.actor_id = c.challenger_user_id then c.recipient_user_id else c.challenger_user_id end)
  order by c.updated_at
  limit greatest(coalesce(p_limit, 100), 1);
$$;
revoke all on function public.call_bs_cancellations_awaiting_notification(integer, interval) from public, anon, authenticated;
grant execute on function public.call_bs_cancellations_awaiting_notification(integer, interval) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 11. The Pick's state, derived (never stored): one answer for every surface
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- states: NO_PICK, UNSTAKED_EDITABLE, UNSTAKED_LOCKED_T10, STAKED_LOCKED_CONFIDENCE, LOCKED_CALL_BS, GRADED, VOID (and LOCKED_OTHER for a Pick locked only by a retired reason, e.g. a monetary position).
-- Lock sources overlap (a staked Pick may also have an accepted Call BS): lock_sources lists every one (CONFIDENCE, CALL_BS, T10, or another stored reason). Precedence of the headline state:
-- graded/void, then Confidence, then Call BS, then the deadline, then editable.
create or replace function public.pick_state(p_user_id uuid, p_market_id uuid)
returns table (state text, prediction_id uuid, selected_outcome text, lock_sources text[], can_change_team boolean, can_attach_confidence boolean, deadline_at timestamptz, is_open boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_p public.predictions;
  v_w record;
  v_staked boolean;
  v_accepted boolean;
  v_sources text[] := '{}';
  v_state text;
  v_timing_locked boolean;
begin
  select * into v_w from public.pick_action_window(p_market_id);
  select * into v_p from public.predictions where user_id = p_user_id and market_id = p_market_id;
  if not found then
    return query select 'NO_PICK'::text, null::uuid, null::text, '{}'::text[], coalesce(v_w.is_open, false), false, v_w.effective_lock_at, coalesce(v_w.is_open, false);
    return;
  end if;
  v_staked := exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = v_p.id);
  v_accepted := exists (select 1 from public.challenges c where c.status = 'ACCEPTED' and (c.challenger_prediction_id = v_p.id or c.recipient_prediction_id = v_p.id));
  v_timing_locked := v_p.lifecycle_state <> 'GRADED' and (coalesce(v_w.is_open, false) is not true or v_p.lock_reason = 'CUTOFF');
  if v_staked then v_sources := array_append(v_sources, 'CONFIDENCE'); end if;
  if v_accepted then v_sources := array_append(v_sources, 'CALL_BS'); end if;
  if v_timing_locked then v_sources := array_append(v_sources, 'T10'); end if;
  if v_p.locked_at is not null and v_p.lock_reason is not null and v_p.lock_reason not in ('CONFIDENCE_COMMITTED', 'CHALLENGE_ACCEPTED', 'CUTOFF') then v_sources := array_append(v_sources, v_p.lock_reason); end if;

  v_state := case
    when v_p.lifecycle_state = 'GRADED' and v_p.result = 'VOID' then 'VOID'
    when v_p.lifecycle_state = 'GRADED' then 'GRADED'
    when v_staked then 'STAKED_LOCKED_CONFIDENCE'
    when v_accepted then 'LOCKED_CALL_BS'
    when v_timing_locked then 'UNSTAKED_LOCKED_T10'
    when v_p.locked_at is not null then 'LOCKED_OTHER'
    else 'UNSTAKED_EDITABLE'
  end;
  return query select v_state, v_p.id, v_p.selected_outcome, v_sources,
    v_state = 'UNSTAKED_EDITABLE',
    (v_p.lifecycle_state <> 'GRADED' and not v_staked and coalesce(v_w.is_open, false) and v_p.lock_reason is distinct from 'CUTOFF'),
    v_w.effective_lock_at, coalesce(v_w.is_open, false);
end;
$$;
revoke all on function public.pick_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pick_state(uuid, uuid) to service_role;

-- What the Pick card shows about Confidence: the same answer as before, with the deadline read from the one timing rule (a Pick an accepted Call BS has locked is still 'open' to Confidence until T-10).
create or replace function public.confidence_stake_status(p_member_id uuid, p_prediction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_pred public.predictions;
  v_stake public.confidence_prediction_stakes;
  v_account public.confidence_accounts;
  v_w record;
begin
  select * into v_s from public.platform_settings where id = true;
  select * into v_pred from public.predictions where id = p_prediction_id;
  if not found or v_pred.user_id <> p_member_id then return jsonb_build_object('state', 'none'); end if;
  -- An existing commitment is always shown (and settles), whatever the capability says.
  select * into v_stake from public.confidence_prediction_stakes where prediction_id = p_prediction_id;
  if found then
    return jsonb_build_object('state', 'staked', 'amount', v_stake.amount, 'stakeState', v_stake.state, 'result', v_stake.result);
  end if;
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('state', 'unavailable', 'reason', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('state', 'unavailable', 'reason', 'ineligible'); end if;
  if v_pred.lifecycle_state <> 'PENDING' then return jsonb_build_object('state', 'closed', 'reason', 'graded'); end if;
  select * into v_w from public.pick_action_window(v_pred.market_id);
  if not found then return jsonb_build_object('state', 'closed', 'reason', 'market'); end if;
  if v_w.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('state', 'closed', 'reason', 'game_started'); end if;
  if not v_w.is_open or v_pred.lock_reason = 'CUTOFF' then return jsonb_build_object('state', 'closed', 'reason', 'deadline'); end if;
  select * into v_account from public.confidence_accounts where member_id = p_member_id;
  return jsonb_build_object('state', 'open', 'available', coalesce(v_account.available, 0), 'allowedStakes', to_jsonb(v_s.confidence_allowed_stakes), 'locksAt', v_w.effective_lock_at);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 12. Era-aware reconciliation and diagnostics
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Only a MANDATORY-ERA Pick (created at/after the cutover and before optional Picks were first enabled) without a stake is a defect. Legacy and optional-era unstaked Picks are valid.
create or replace function public.confidence_reconcile_stakes(p_grace_minutes integer default 15)
returns table (kind text, stake_id uuid, member_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select 'SETTLED_WITHOUT_ENTRY', s.id, s.member_id from public.confidence_prediction_stakes s
    where s.state <> 'RESERVED' and not exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type in ('PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS'))
  union all
  select 'ENTRY_WITHOUT_SETTLEMENT', s.id, s.member_id from public.confidence_prediction_stakes s
    where s.state = 'RESERVED' and exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type in ('PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS'))
  union all
  select 'RESERVE_ENTRY_MISSING_OR_WRONG', s.id, s.member_id from public.confidence_prediction_stakes s
    where not exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type = 'PREDICTION_RESERVE' and e.reserved_delta = s.amount and e.member_id = s.member_id)
  union all
  select 'STRANDED_RESERVE', s.id, s.member_id from public.confidence_prediction_stakes s join public.predictions p on p.id = s.prediction_id
    where s.state = 'RESERVED' and p.lifecycle_state = 'GRADED' and p.graded_at < now() - make_interval(mins => greatest(coalesce(p_grace_minutes, 15), 0))
  union all
  select 'PICK_WITHOUT_STAKE_AFTER_CUTOVER', null::uuid, p.user_id from public.predictions p
    where (select confidence_mandatory_since from public.platform_settings where id = true) is not null
      and p.created_at >= (select confidence_mandatory_since from public.platform_settings where id = true)
      and ((select confidence_optional_first_enabled_at from public.platform_settings where id = true) is null
           or p.created_at < (select confidence_optional_first_enabled_at from public.platform_settings where id = true))
      and not exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = p.id);
$$;

create or replace function public.confidence_prediction_capacity()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (select confidence_allowed_stakes as ladder, confidence_mandatory_since as since, confidence_optional_picks_enabled as optional_on, confidence_optional_first_enabled_at as optional_since
             from public.platform_settings where id = true),
  p as (select p.id, p.created_at, p.lifecycle_state, (st.id is not null) as staked
        from public.predictions p left join public.confidence_prediction_stakes st on st.prediction_id = p.id)
  select jsonb_build_object(
    'mandatorySince', (select since from s),
    'optionalPicksEnabled', (select optional_on from s),
    'optionalFirstEnabledAt', (select optional_since from s),
    'minimumStake', (select ladder[1] from s),
    -- Members who cannot make a new prediction right now: less available Confidence than the smallest allowed stake.
    'unableToPredict', (select count(*) from public.confidence_accounts a, s where a.available < s.ladder[1]),
    'legacyPicks', (select jsonb_build_object(
        'total', count(*) filter (where st.id is null),
        'graded', count(*) filter (where st.id is null and p.lifecycle_state = 'GRADED'),
        'open', count(*) filter (where st.id is null and p.lifecycle_state = 'PENDING'),
        'openAndEditable', count(*) filter (where st.id is null and p.lifecycle_state = 'PENDING' and p.locked_at is null))
      from public.predictions p left join public.confidence_prediction_stakes st on st.prediction_id = p.id),
    'backedPicks', (select count(*) from public.confidence_prediction_stakes),
    -- Era split: legacy = before the mandatory cutover; mandatory = from the cutover until optional Picks were first enabled (every Pick should be backed: an unstaked one is a defect); optional = from then on (unstaked is valid).
    'eras', jsonb_build_object(
      'legacy', (select jsonb_build_object('picks', count(*), 'unstaked', count(*) filter (where not staked)) from p, s where s.since is null or p.created_at < s.since),
      'mandatory', (select jsonb_build_object('picks', count(*), 'unstaked', count(*) filter (where not staked)) from p, s where s.since is not null and p.created_at >= s.since and (s.optional_since is null or p.created_at < s.optional_since)),
      'optional', (select jsonb_build_object('picks', count(*), 'unstaked', count(*) filter (where not staked), 'staked', count(*) filter (where staked)) from p, s where s.optional_since is not null and p.created_at >= s.optional_since)),
    'optionalMetrics', jsonb_build_object(
      'unstakedPickEdits', (select count(*) from public.prediction_revisions r join p on p.id = r.prediction_id, s where s.optional_since is not null and p.created_at >= s.optional_since and not p.staked),
      'pickChangedExpiries', (select count(*) from public.challenges where expiry_reason = 'PICK_CHANGED'),
      'attachedAfterPick', (select count(*) from public.confidence_prediction_stakes st join public.predictions pr on pr.id = st.prediction_id, s where s.optional_since is not null and pr.created_at >= s.optional_since and st.created_at > pr.created_at + interval '1 second')));
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 13. T-10 is the only Member deadline (documentation of the contract; no behaviour)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
comment on column public.platform_settings.pick_lock_minutes_before_kickoff is
  'Brohda''s ONLY Member prediction deadline (T-10 by default): no new Picks, no Pick edits, no Confidence attached, no new or accepted Call BS from this many minutes before kickoff; pending Call BS expire. Read by public.pick_lock_deadline / pick_action_window with clock_timestamp() after locks. There is no T-5.';
comment on column public.platform_settings.prediction_cutoff_minutes_before_close is
  'DEPRECATED, outside the Brohda 2.1 Member contract: a market-close-relative cutoff. Sports Markets have no close time (markets.closes_at is null), so it does not fire. T-10 (pick_lock_minutes_before_kickoff) is the only Member deadline.';
