-- BROHDA 2.1 — M2: team-winner-only active product + odds independence.
--
-- Goal: a Game, not a sportsbook price, decides whether Brohda can offer "who wins?". Every statement below is ADDITIVE or constraint-relaxing, and every new
-- behaviour is behind a setting whose DEFAULT reproduces the pre-M2 behaviour exactly, so applying this migration changes nothing by itself.
--
--   1. Four settings on platform_settings (defaults preserve today's behaviour):
--        fixture_markets_enabled        false  — whether a Game may get its canonical MONEYLINE Market without waiting for odds
--        prediction_require_price       true   — whether a Market needs usable price data before a Member may Pick it
--        prediction_allowed_templates   all    — which Market templates Members may START new interaction with (Pick / Call BS)
--        market_ingestion_templates     all    — which Market templates sportsbook ingestion may create/update
--   2. The price snapshots on Picks and Pick revisions become nullable. NULL means "there was no price at Pick time" — never a substituted 0.5 / -110 / EVEN.
--      A snapshot pair is both-null or both-non-null. Existing rows are not touched.
--   3. ensure_fixture_moneyline_markets(): insert-if-absent of THE canonical MONEYLINE Market of a Game, with the SAME identity sportsbook ingestion already uses
--      (fixtures.provider, '<external_fixture_id>:MONEYLINE', HOME), so odds arriving later enrich the same row. It never writes a price and never overwrites one.
--   4. market_template_allowed(): the one database rule for "may Members start something new on this template", used by set_pick and call_bs (server enforcement,
--      not React). New Picks / new challenges are refused on a disallowed template; commitments that already exist are finished.
--   5. set_pick / create_confidence_prediction / call_bs: the template guard and the price backstop above. Their bodies are otherwise unchanged from migration 211.
--   6. admin_set_market_policy(): the audited Super-Admin switch for the four settings (partial update: NULL = leave as is).
--
-- No grading, Confidence, ledger, Call BS resolution or settlement function is changed. No down migration: rollback is by setting values back.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Settings
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column fixture_markets_enabled boolean not null default false,
  add column prediction_require_price boolean not null default true,
  add column prediction_allowed_templates text[] not null default array['MONEYLINE', 'SPREAD', 'TOTAL'],
  add column market_ingestion_templates text[] not null default array['MONEYLINE', 'SPREAD', 'TOTAL'];

-- Fail closed at the data layer: only the real templates, never a NULL element. An empty list is legal and means "nothing is offered".
alter table public.platform_settings
  add constraint platform_settings_prediction_allowed_templates_valid
    check (prediction_allowed_templates <@ array['MONEYLINE', 'SPREAD', 'TOTAL']::text[] and array_position(prediction_allowed_templates, null) is null),
  add constraint platform_settings_market_ingestion_templates_valid
    check (market_ingestion_templates <@ array['MONEYLINE', 'SPREAD', 'TOTAL']::text[] and array_position(market_ingestion_templates, null) is null);

comment on column public.platform_settings.fixture_markets_enabled is
  'M2: when true, the market job may create a Game''s canonical MONEYLINE Market from the Game itself (no price). Default false = a Market exists only once sportsbook ingestion created it (pre-M2 behaviour).';
comment on column public.platform_settings.prediction_require_price is
  'M2: when true (default, pre-M2 behaviour) a Market needs usable price data before a Member may Pick it. When false, price is enrichment only: a team-winner Pick is available until the real deadline whatever the sportsbook coverage, and its price snapshot is NULL if no price existed.';
comment on column public.platform_settings.prediction_allowed_templates is
  'M2: the Market templates Members may START new interaction with (new Pick, new Call BS), enforced in the database (market_template_allowed). Existing Picks and challenges are finished regardless. Default = all three (pre-M2). M2 target = {MONEYLINE}.';
comment on column public.platform_settings.market_ingestion_templates is
  'M2: the Market templates sportsbook ingestion may create/update, intersected with each sport''s own registered templates. Default = all three (pre-M2). M2 target = {MONEYLINE}. Existing rows are never deleted.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Nullable price snapshots (relaxation only: no existing value is read, rewritten or nulled)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.predictions
  alter column yes_probability_snapshot drop not null,
  alter column no_probability_snapshot drop not null;
alter table public.predictions
  add constraint predictions_probability_snapshot_pair check ((yes_probability_snapshot is null) = (no_probability_snapshot is null));

alter table public.prediction_revisions
  alter column previous_probability_snapshot drop not null,
  alter column new_probability_snapshot drop not null;

comment on column public.predictions.yes_probability_snapshot is
  'The YES price at Pick time, or NULL when no price existed then. Never a substituted value. Pair-checked with no_probability_snapshot.';
comment on column public.predictions.no_probability_snapshot is
  'The NO price at Pick time, or NULL when no price existed then. Never a substituted value. Pair-checked with yes_probability_snapshot.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. The template rule (server-side)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.market_template_allowed(p_market_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Fail closed: an unknown Market, or an unreadable settings row, is "not allowed".
  select coalesce((select m.market_template::text = any (s.prediction_allowed_templates)
                   from public.markets m cross join public.platform_settings s
                   where m.id = p_market_id and s.id = true), false);
$$;
revoke all on function public.market_template_allowed(uuid) from public, anon, authenticated;
grant execute on function public.market_template_allowed(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. The canonical, price-less MONEYLINE Market of a Game
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- ONE canonical MONEYLINE per Game, in any state and on either side. The existing proposition index (fixture, template, line, side) would still allow a second row on the other
-- side; this closes that. Production was verified read-only on 2026-10-24: no Game has more than one MONEYLINE Market and every MONEYLINE is HOME, so the index builds cleanly.
create unique index markets_one_moneyline_per_fixture on public.markets (fixture_id) where market_template = 'MONEYLINE';

-- Candidates are chosen by the caller (which Games are eligible is data: the sport registry and its windows). This function only validates the Game
-- (exists, not started) and inserts when NO MONEYLINE Market exists for it in any state or side. Identity matches sportsbook ingestion exactly, so a later
-- odds run upserts this very row (provider, provider_market_id). ON CONFLICT DO NOTHING is the concurrency backstop on both unique constraints.
-- It returns the ids it inserted. With fixture_markets_enabled = false it does nothing.
create or replace function public.ensure_fixture_moneyline_markets(p_fixture_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_ids uuid[];
begin
  select s.fixture_markets_enabled into v_enabled from public.platform_settings s where s.id = true;
  if v_enabled is not true or p_fixture_ids is null or cardinality(p_fixture_ids) = 0 then
    return '{}'::uuid[];
  end if;

  with candidates as (
    select f.id, f.provider, f.external_fixture_id, f.home_team_name
    from public.fixtures f
    where f.id = any (p_fixture_ids)
      and f.internal_status = 'NOT_STARTED'
      and f.scheduled_start_utc > now()
      and f.home_team_name is not null and f.away_team_name is not null
  ), inserted as (
    insert into public.markets (
      provider, provider_market_id, provider_event_id, question, status, yes_price, no_price, price_outcome_labels,
      last_synced_at, ingestion_source, provider_metadata, fixture_id, market_template, line_value, yes_side
    )
    select c.provider, c.external_fixture_id || ':MONEYLINE', c.external_fixture_id, 'Will the ' || c.home_team_name || ' win?', 'ACTIVE', null, null, null,
           now(), 'fixture', '{}'::jsonb, c.id, 'MONEYLINE', null, 'HOME'
    from candidates c
    where not exists (select 1 from public.markets m where m.fixture_id = c.id and m.market_template = 'MONEYLINE')
    on conflict do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from inserted;
  return v_ids;
end;
$$;
revoke all on function public.ensure_fixture_moneyline_markets(uuid[]) from public, anon, authenticated;
grant execute on function public.ensure_fixture_moneyline_markets(uuid[]) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. set_pick / create_confidence_prediction / call_bs (bodies from migration 211 with the M2 guards)
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

  -- M2 price policy. A price snapshot is a PAIR: both sides were observed at Pick time, or neither was (NULL, never a substituted number).
  -- With prediction_require_price on (the default, and the behaviour before M2) a Pick without a price is refused here as a backstop to the application check.
  if (p_yes_probability is null) <> (p_no_probability is null) then
    raise exception 'invalid_probability_pair';
  end if;
  if v_s.prediction_require_price is not false and (p_yes_probability is null or p_no_probability is null) then
    return (null, 'rejected_price_required', null)::public.set_pick_result;
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
    -- M2: only the templates Members are currently offered take NEW Picks. Existing Picks keep working (edit, Confidence, Call BS) so commitments already made are finished.
    if not public.market_template_allowed(p_market_id) then
      return (null, 'rejected_template_not_allowed', null)::public.set_pick_result;
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
      when 'rejected_template_not_allowed' then 'template_not_allowed' when 'rejected_price_required' then 'price_required'
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

  -- M2: a NEW challenge needs a Market of a template Members are currently offered. A challenge that already exists is still accepted, resolved and settled (accept_call_bs is untouched).
  if not public.market_template_allowed(v_recipient_pred.market_id) then
    raise exception 'market_template_not_allowed';
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

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. The audited Super-Admin switch (partial update: NULL = leave that setting as it is; idempotent; no row and no audit entry when nothing changes)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_market_policy(
  p_admin_id uuid,
  p_fixture_markets_enabled boolean default null,
  p_require_price boolean default null,
  p_allowed_templates text[] default null,
  p_ingestion_templates text[] default null
)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_valid constant text[] := array['MONEYLINE', 'SPREAD', 'TOTAL'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_allowed_templates is not null and (not (p_allowed_templates <@ v_valid) or array_position(p_allowed_templates, null) is not null) then
    raise exception 'invalid_templates';
  end if;
  if p_ingestion_templates is not null and (not (p_ingestion_templates <@ v_valid) or array_position(p_ingestion_templates, null) is not null) then
    raise exception 'invalid_templates';
  end if;

  select * into v_before from public.platform_settings where id = true for update;
  if (p_fixture_markets_enabled is null or p_fixture_markets_enabled = v_before.fixture_markets_enabled)
     and (p_require_price is null or p_require_price = v_before.prediction_require_price)
     and (p_allowed_templates is null or p_allowed_templates is not distinct from v_before.prediction_allowed_templates)
     and (p_ingestion_templates is null or p_ingestion_templates is not distinct from v_before.market_ingestion_templates) then
    return v_before;
  end if;

  update public.platform_settings set
    fixture_markets_enabled = coalesce(p_fixture_markets_enabled, fixture_markets_enabled),
    prediction_require_price = coalesce(p_require_price, prediction_require_price),
    prediction_allowed_templates = coalesce(p_allowed_templates, prediction_allowed_templates),
    market_ingestion_templates = coalesce(p_ingestion_templates, market_ingestion_templates),
    updated_at = now(), updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.market_policy_updated', 'platform_settings', null,
      jsonb_build_object('fixture_markets_enabled', v_before.fixture_markets_enabled, 'prediction_require_price', v_before.prediction_require_price,
        'prediction_allowed_templates', v_before.prediction_allowed_templates, 'market_ingestion_templates', v_before.market_ingestion_templates),
      jsonb_build_object('fixture_markets_enabled', v_after.fixture_markets_enabled, 'prediction_require_price', v_after.prediction_require_price,
        'prediction_allowed_templates', v_after.prediction_allowed_templates, 'market_ingestion_templates', v_after.market_ingestion_templates));
  return v_after;
end;
$$;
revoke all on function public.admin_set_market_policy(uuid, boolean, boolean, text[], text[]) from public, anon, authenticated;
grant execute on function public.admin_set_market_policy(uuid, boolean, boolean, text[], text[]) to service_role;
