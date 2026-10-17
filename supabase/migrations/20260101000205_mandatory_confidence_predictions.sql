-- Confidence is part of the prediction itself: every NEW Pick is created together with the Confidence behind it, in one transaction.
--
-- This migration is additive. It adds the one atomic creation function (create_confidence_prediction), a cutover switch (platform_settings.confidence_mandatory_since) and — once that switch is set — the database-level
-- enforcement that retires every other way to create a Pick: the generic set_pick() and the separate attach refuse to run outside the composer, and a deferred constraint trigger refuses to COMMIT a new Pick that has no stake.
-- Until the switch is set nothing about existing behaviour is enforced differently; Picks made before the cutover (graded history, and the few still-open unbacked ones) are never touched or given an invented stake.

alter table public.platform_settings add column confidence_mandatory_since timestamptz;
comment on column public.platform_settings.confidence_mandatory_since is
  'Cutover instant for "every new Pick needs Confidence behind it". NULL = not enforced by the database yet. When set, a Pick created at or after this instant must have a Confidence stake or its transaction fails to commit; set_pick and the separate stake attach refuse to run outside create_confidence_prediction. Pre-cutover Picks are legacy records and are never given a stake.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- set_pick: after the cutover it is no longer a Member action. Only the composer (which sets a transaction-local switch) may call it; a direct call is refused with a plain outcome.
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
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_effective_lock_at timestamptz;
  v_result public.predictions;
  v_mandatory_since timestamptz;
begin
  if p_selected_outcome not in ('YES', 'NO') then
    raise exception 'invalid_selected_outcome';
  end if;

  -- After the cutover a Pick exists only together with its Confidence: the one function that creates both sets this switch for its own transaction; nothing else may persist a Pick.
  select confidence_mandatory_since into v_mandatory_since from public.platform_settings where id = true;
  if v_mandatory_since is not null and coalesce(current_setting('brohda.confidence_composer', true), 'off') <> 'on' then
    return (null, 'rejected_backing_required')::public.set_pick_result;
  end if;

  select * into v_replay from public.predictions where idempotency_key = p_idempotency_key;
  if found then
    return (v_replay, 'replayed')::public.set_pick_result;
  end if;

  select t.fixture_status, t.scheduled_start, t.effective_lock_at
    into v_fixture_status, v_scheduled_start, v_effective_lock_at
    from public.pick_market_timing(p_market_id) t;

  if not found then
    raise exception 'market_not_found';
  end if;

  select * into v_existing from public.predictions where user_id = p_user_id and market_id = p_market_id for update;

  if not found then
    if v_fixture_status <> 'NOT_STARTED' then
      return (null, 'rejected_game_closed')::public.set_pick_result;
    end if;
    if now() >= v_effective_lock_at then
      return (null, 'rejected_cutoff')::public.set_pick_result;
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
      return (v_result, 'created')::public.set_pick_result;
    exception when unique_violation then
      return public.set_pick(p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability, p_market_question, p_market_close_at, p_market_status, p_idempotency_key);
    end;
  end if;

  if v_existing.locked_at is not null or v_existing.lifecycle_state = 'GRADED' then
    return (v_existing, 'rejected_locked')::public.set_pick_result;
  end if;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    update public.predictions set locked_at = least(now(), v_effective_lock_at), lock_reason = 'CUTOFF', updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.set_pick_result;
  end if;

  if v_existing.selected_outcome = p_selected_outcome then
    return (v_existing, 'unchanged')::public.set_pick_result;
  end if;

  insert into public.prediction_revisions (
    prediction_id, user_id, previous_selected_outcome, previous_probability_snapshot, new_selected_outcome, new_probability_snapshot
  ) values (
    v_existing.id, p_user_id, v_existing.selected_outcome,
    case when v_existing.selected_outcome = 'YES' then v_existing.yes_probability_snapshot else v_existing.no_probability_snapshot end,
    p_selected_outcome,
    case when p_selected_outcome = 'YES' then p_yes_probability else p_no_probability end
  );

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

  return (v_result, 'updated')::public.set_pick_result;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The one way to make a prediction: side + Confidence, in ONE transaction
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Everything is validated first and returns a plain outcome without writing anything; only then does it create the Pick, the stake, the reserve (ledger) and the lock together. Any unexpected failure raises, which rolls the whole
-- transaction back, so there is never a Pick without a stake, a stake without a Pick, a reserve without a Pick, or a Pick that is still editable. A Pick that exists from before the cutover and is still open (never locked) is COMPLETED
-- here — the Member picks its side and Confidence like any other prediction — and a legacy Pick that is already locked or graded is left exactly as it is.
-- Idempotent: the same key never produces a second Pick, stake or reserve (a per-(Member, Market) transaction lock serialises double taps).
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
  v_timing record;
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
  -- Predictions exist only with Confidence: with either switch off nothing can be created.
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_user_id) then return jsonb_build_object('outcome', 'ineligible'); end if;

  -- One request per (Member, Market) at a time: a double tap waits here and then finds the first one's result (a replay).
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_market_id::text, 0));

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

  -- The canonical deadline, evaluated NOW against authoritative Game state — never the client.
  select * into v_timing from public.pick_market_timing(p_market_id);
  if not found then raise exception 'market_not_found'; end if;
  if v_timing.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('outcome', 'game_started'); end if;
  if clock_timestamp() >= v_timing.effective_lock_at then return jsonb_build_object('outcome', 'past_deadline'); end if;

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
  -- Every prediction is final the moment it exists.
  update public.predictions set locked_at = coalesce(locked_at, now()), lock_reason = coalesce(lock_reason, 'CONFIDENCE_COMMITTED'), updated_at = now() where id = v_pred.id;

  return jsonb_build_object('outcome', 'created', 'predictionId', v_pred.id, 'stakeId', v_stake.id, 'selectedOutcome', v_pred.selected_outcome, 'amount', p_amount,
    'available', v_entry.available_after, 'reserved', v_entry.reserved_after, 'total', v_entry.available_after + v_entry.reserved_after);
end;
$$;
revoke all on function public.create_confidence_prediction(uuid, uuid, text, integer, numeric, numeric, text, timestamp with time zone, text, text) from public, anon, authenticated;
grant execute on function public.create_confidence_prediction(uuid, uuid, text, integer, numeric, numeric, text, timestamp with time zone, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The separate attach is retired once the cutover is set: backing a Pick is part of creating it
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_attach_stake(p_member_id uuid, p_prediction_id uuid, p_amount integer, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_pred public.predictions;
  v_account public.confidence_accounts;
  v_prior public.confidence_ledger_entries;
  v_prior_stake public.confidence_prediction_stakes;
  v_timing record;
  v_fixture uuid;
  v_stake public.confidence_prediction_stakes;
  v_entry public.confidence_ledger_entries;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_mandatory_since is not null then return jsonb_build_object('outcome', 'retired'); end if;
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('outcome', 'ineligible'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;
  if p_amount is null or p_amount < 1 then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  select * into v_pred from public.predictions where id = p_prediction_id for update;
  if not found or v_pred.user_id <> p_member_id then return jsonb_build_object('outcome', 'not_found'); end if;

  select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_prior_stake from public.confidence_prediction_stakes where id = v_prior.stake_id;
    if v_prior_stake.prediction_id is distinct from p_prediction_id then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    return jsonb_build_object('outcome', 'attached', 'replay', true, 'stakeId', v_prior_stake.id, 'amount', v_prior_stake.amount);
  end if;

  if exists (select 1 from public.confidence_prediction_stakes where prediction_id = p_prediction_id) then return jsonb_build_object('outcome', 'already_backed'); end if;
  if v_pred.lifecycle_state <> 'PENDING' then return jsonb_build_object('outcome', 'pick_graded'); end if;

  select * into v_timing from public.pick_market_timing(v_pred.market_id);
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_timing.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('outcome', 'game_started'); end if;
  if clock_timestamp() >= v_timing.effective_lock_at or v_pred.lock_reason = 'CUTOFF' then return jsonb_build_object('outcome', 'past_deadline'); end if;

  if not (p_amount = any (v_s.confidence_allowed_stakes)) then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  perform public.confidence_bootstrap_member(p_member_id);
  select * into v_account from public.confidence_accounts where member_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;
  if v_account.available < p_amount then return jsonb_build_object('outcome', 'insufficient', 'available', v_account.available); end if;

  select m.fixture_id into v_fixture from public.markets m where m.id = v_pred.market_id;
  insert into public.confidence_prediction_stakes (member_id, prediction_id, market_id, fixture_id, selected_outcome, amount, allowed_stakes_snapshot)
    values (p_member_id, p_prediction_id, v_pred.market_id, v_fixture, v_pred.selected_outcome, p_amount, v_s.confidence_allowed_stakes)
    returning * into v_stake;
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, stake_id, idempotency_key, metadata)
    values (p_member_id, 'PREDICTION_RESERVE', -p_amount, p_amount, v_stake.id, p_idempotency_key, jsonb_build_object('predictionId', p_prediction_id))
    returning * into v_entry;
  update public.predictions set locked_at = coalesce(locked_at, now()), lock_reason = coalesce(lock_reason, 'CONFIDENCE_COMMITTED'), updated_at = now() where id = p_prediction_id;

  return jsonb_build_object('outcome', 'attached', 'stakeId', v_stake.id, 'amount', p_amount, 'available', v_entry.available_after, 'reserved', v_entry.reserved_after, 'total', v_entry.available_after + v_entry.reserved_after);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The invariant itself: a Pick created at/after the cutover cannot COMMIT without a stake
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_pick_requires_stake()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz;
begin
  select confidence_mandatory_since into v_since from public.platform_settings where id = true;
  if v_since is not null and new.created_at >= v_since and not exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = new.id) then
    raise exception 'a Pick cannot exist without Confidence behind it';
  end if;
  return null;
end;
$$;
create constraint trigger predictions_require_confidence after insert on public.predictions
  deferrable initially deferred for each row execute function public.confidence_pick_requires_stake();
revoke all on function public.confidence_pick_requires_stake() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Reconciliation: after the cutover a Pick without a stake is a defect
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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
      and not exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = p.id);
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Observability: capacity to predict, and the legacy/backed split
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_prediction_capacity()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with s as (select confidence_allowed_stakes as ladder, confidence_mandatory_since as since from public.platform_settings where id = true)
  select jsonb_build_object(
    'mandatorySince', (select since from s),
    'minimumStake', (select ladder[1] from s),
    -- Members who cannot make a new prediction right now: less available Confidence than the smallest allowed stake.
    'unableToPredict', (select count(*) from public.confidence_accounts a, s where a.available < s.ladder[1]),
    'legacyPicks', (select jsonb_build_object(
        'total', count(*) filter (where st.id is null),
        'graded', count(*) filter (where st.id is null and p.lifecycle_state = 'GRADED'),
        'open', count(*) filter (where st.id is null and p.lifecycle_state = 'PENDING'),
        'openAndEditable', count(*) filter (where st.id is null and p.lifecycle_state = 'PENDING' and p.locked_at is null))
      from public.predictions p left join public.confidence_prediction_stakes st on st.prediction_id = p.id),
    'backedPicks', (select count(*) from public.confidence_prediction_stakes));
$$;
revoke all on function public.confidence_prediction_capacity() from public, anon, authenticated;
grant execute on function public.confidence_prediction_capacity() to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The audited settings function: the cutover switch (true sets it to now() once; false clears it)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_confidence_config(p_admin_id uuid, p_config jsonb)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_key text;
  v_b jsonb;
  v_a jsonb;
  v_stakes integer[];
  v_mandatory_since timestamptz;
  v_allowed text[] := array['confidence_enabled', 'confidence_backed_picks_enabled', 'confidence_baseline', 'confidence_daily_claim_amount', 'confidence_daily_claim_interval_hours', 'confidence_allowed_stakes',
    'confidence_notify_correct', 'confidence_notify_incorrect', 'confidence_notify_void', 'confidence_mandatory'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  if p_config ? 'confidence_allowed_stakes' then
    if jsonb_typeof(p_config -> 'confidence_allowed_stakes') <> 'array' then raise exception 'invalid_stakes'; end if;
    select array_agg(x.value::integer order by x.ord) into v_stakes from jsonb_array_elements_text(p_config -> 'confidence_allowed_stakes') with ordinality as x(value, ord);
    if v_stakes is null then raise exception 'invalid_stakes'; end if;
  end if;
  select * into v_before from public.platform_settings where id = true for update;
  v_mandatory_since := v_before.confidence_mandatory_since;
  if p_config ? 'confidence_mandatory' then
    if jsonb_typeof(p_config -> 'confidence_mandatory') <> 'boolean' then raise exception 'invalid_mandatory'; end if;
    if (p_config ->> 'confidence_mandatory')::boolean then
      v_mandatory_since := coalesce(v_before.confidence_mandatory_since, now());
    else
      v_mandatory_since := null;
    end if;
  end if;
  update public.platform_settings set
    confidence_enabled = coalesce((p_config ->> 'confidence_enabled')::boolean, confidence_enabled),
    confidence_backed_picks_enabled = coalesce((p_config ->> 'confidence_backed_picks_enabled')::boolean, confidence_backed_picks_enabled),
    confidence_baseline = coalesce((p_config ->> 'confidence_baseline')::integer, confidence_baseline),
    confidence_daily_claim_amount = coalesce((p_config ->> 'confidence_daily_claim_amount')::integer, confidence_daily_claim_amount),
    confidence_daily_claim_interval_hours = coalesce((p_config ->> 'confidence_daily_claim_interval_hours')::integer, confidence_daily_claim_interval_hours),
    confidence_allowed_stakes = coalesce(v_stakes, confidence_allowed_stakes),
    confidence_notify_correct = coalesce(p_config ->> 'confidence_notify_correct', confidence_notify_correct),
    confidence_notify_incorrect = coalesce(p_config ->> 'confidence_notify_incorrect', confidence_notify_incorrect),
    confidence_notify_void = coalesce(p_config ->> 'confidence_notify_void', confidence_notify_void),
    confidence_mandatory_since = v_mandatory_since,
    updated_at = now(), updated_by = p_admin_id
    where id = true returning * into v_after;
  -- A cutover with predictions switched off would leave nobody able to predict: refuse that combination outright.
  if v_after.confidence_mandatory_since is not null and (v_after.confidence_enabled is not true or v_after.confidence_backed_picks_enabled is not true) then
    raise exception 'mandatory_requires_predictions_on';
  end if;
  v_b := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_before)) where key like 'confidence\_%');
  v_a := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_after)) where key like 'confidence\_%');
  if v_b is distinct from v_a then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.confidence_updated', 'platform_settings', null, v_b, v_a);
  end if;
  return v_after;
end;
$$;
