-- Milestone R5 (docs/BROHDA_2_0_MILESTONE_MAP.md, Pick Editing + Locking).
-- Additive only. Changes `predictions` from write-once to "current/final
-- record, mutable pre-lock, permanently frozen at lock" — see
-- docs/architecture/pick-editing-and-locking.md for the full rationale.
--
-- Verified before writing this migration: 28 existing local predictions
-- rows, zero (user_id, market_id) duplicates — the unique constraint below
-- is safe to add directly, no backfill/dedup required.

-- One current Pick per user per Market (R0.5's own finding: this was
-- previously enforced only at application level). Concurrency-safe
-- creation/editing (set_pick() below) depends on this being a real
-- constraint, not a convention.
alter table public.predictions
  add constraint predictions_one_per_user_market unique (user_id, market_id);

-- Permanent lock state (§12-13, §17). `locked_at`/`lock_reason` are always
-- both-null or both-set together — enforced by the shape constraint below.
-- 'CHALLENGE_ACCEPTED' is included now, unused, because it is not
-- speculative: it is the exact, already-named future primitive R7 (Free
-- Call BS Challenges) requires (docs/BROHDA_2_0_MILESTONE_MAP.md's own
-- R7 section). No Challenge code exists or is introduced by this
-- migration — only the vocabulary slot a future milestone will use.
alter table public.predictions
  add column locked_at timestamptz,
  add column lock_reason text check (lock_reason in ('CUTOFF', 'CHALLENGE_ACCEPTED'));

alter table public.predictions
  add constraint predictions_lock_shape check (
    (locked_at is null and lock_reason is null) or (locked_at is not null and lock_reason is not null)
  );

comment on column public.predictions.locked_at is
  'When this Pick became permanently non-editable. Materialized lazily (§14): the effective cutoff is always computable live from the Market''s Game kickoff, so a Pick can be EFFECTIVELY locked before this column is set — set_pick() and the grading job both materialize it on first touch past the effective cutoff. One-way: no code path in this application ever nulls this column back out.';
comment on column public.predictions.lock_reason is
  'Why this Pick locked. CUTOFF = the configured Pick cutoff before kickoff passed (R5, the only reason ever actually set today). CHALLENGE_ACCEPTED is reserved vocabulary for R7 — not settable by any current code path.';

-- Append-only revision history (§7-8): captures only what is needed to
-- reconstruct a meaningful Pick CHANGE — never the initial creation
-- (already fully captured by predictions.created_at + the row itself) and
-- never a same-selection idempotent retry (§26 — no fake history). Reuses
-- the existing generic forbid_audit_log_mutation() trigger function
-- (already proven on audit_logs/wallet_transactions) rather than writing a
-- near-duplicate — it takes no table-specific arguments by design.
create table public.prediction_revisions (
  id                          uuid primary key default gen_random_uuid(),
  prediction_id               uuid not null references public.predictions (id),
  user_id                     uuid not null references public.user_profiles (id) on delete cascade,
  previous_selected_outcome   text not null check (previous_selected_outcome in ('YES', 'NO')),
  previous_probability_snapshot numeric not null check (previous_probability_snapshot >= 0 and previous_probability_snapshot <= 1),
  new_selected_outcome        text not null check (new_selected_outcome in ('YES', 'NO')),
  new_probability_snapshot    numeric not null check (new_probability_snapshot >= 0 and new_probability_snapshot <= 1),
  changed_at                  timestamptz not null default now(),

  constraint prediction_revisions_actually_changed check (previous_selected_outcome <> new_selected_outcome)
);

create index idx_prediction_revisions_prediction_id on public.prediction_revisions (prediction_id, changed_at);

alter table public.prediction_revisions enable row level security;

create policy "select_own_prediction_revisions"
on public.prediction_revisions for select
to authenticated
using (user_id = auth.uid());

grant select on public.prediction_revisions to authenticated;
grant select, insert on public.prediction_revisions to service_role;

create trigger prediction_revisions_no_update
before update on public.prediction_revisions
for each row execute function public.forbid_audit_log_mutation();

create trigger prediction_revisions_no_delete
before delete on public.prediction_revisions
for each row execute function public.forbid_audit_log_mutation();

-- Milestone R5 configurable policy (§10, §42) — deliberately a NEW,
-- separate column from the existing prediction_cutoff_minutes_before_close
-- (20260101000142), not a reuse of it: that column is anchored to
-- markets.closes_at (a provider/Market-level concept, currently always
-- null for every R2-ingested sports Market — verified, effectively inert
-- for this product today) while this one is anchored to the canonical
-- Game's own scheduled_start_utc (fixtures), a structurally different
-- clock source per this milestone's own explicit instruction ("do not
-- derive it from... Market ingestion time"). Reusing the old column would
-- have silently conflated two different cutoffs with different meanings.
alter table public.platform_settings
  add column pick_lock_minutes_before_kickoff integer not null default 10 check (pick_lock_minutes_before_kickoff >= 0);

comment on column public.platform_settings.pick_lock_minutes_before_kickoff is
  'Minutes before a Game''s canonical scheduled_start_utc at which ordinary Pick creation/editing stops (the product''s "T-10" rule). Read live by set_pick() on every call — never cached, never derived from Market ingestion/closesAt. Distinct from prediction_cutoff_minutes_before_close, which is a different, Market-closesAt-anchored policy.';

-- Explicit result contract, deliberately NOT exceptions for ordinary
-- business-rule rejections (past cutoff, Game closed, already locked):
-- a Postgres function call is one atomic statement, so raising an
-- exception after the lock-materialization UPDATE below would roll that
-- UPDATE back too, defeating the whole point of materializing it (this
-- was caught by direct SQL testing before this migration was finalized —
-- not a hypothetical). Returning a row (nullable) plus an explicit
-- `outcome` lets every path, including "rejected, but the lock still got
-- persisted," commit exactly what it means to commit. `market_not_found`/
-- `invalid_selected_outcome` remain real raised exceptions — those are
-- caller/programming errors, never a legitimate user-facing outcome.
create type public.set_pick_result as (
  prediction public.predictions,
  outcome text
);

-- The concurrency-safe, atomic create-or-edit-or-reject operation (§11,
-- §25, §27-29). Row-locks any existing Pick for the duration of the
-- transaction (the same SELECT ... FOR UPDATE pattern already proven in
-- apply_wallet_transaction/create_pool_entry) and authoritatively
-- re-reads the Game's live kickoff/status inside that same transaction —
-- the server/database moment of execution decides eligibility, never a
-- pre-computed value handed in from a separate round-trip (§11, §28). This
-- is also the safe serialization point a future R7 Challenge-acceptance
-- operation can lock against (§29) — this migration does not implement
-- that, only leaves the row-lock primitive in place for it to use.
--
-- outcome values: 'created' | 'updated' | 'unchanged' | 'rejected_cutoff'
-- | 'rejected_game_closed' | 'rejected_locked'. `prediction` is null only
-- for 'rejected_cutoff'/'rejected_game_closed' on a brand-new Pick attempt
-- (no row ever existed to return).
create or replace function public.set_pick(
  p_user_id uuid,
  p_market_id uuid,
  p_selected_outcome text,
  p_yes_probability numeric,
  p_no_probability numeric,
  p_market_question text,
  p_market_close_at timestamptz,
  p_market_status text,
  p_idempotency_key text
)
returns public.set_pick_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_replay public.predictions;
  v_existing public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_result public.predictions;
begin
  if p_selected_outcome not in ('YES', 'NO') then
    raise exception 'invalid_selected_outcome';
  end if;

  -- Idempotency-key replay: a retried identical request always returns the
  -- same row, regardless of anything else — matches createPrediction's own
  -- pre-R5 contract exactly, preserved unchanged.
  select * into v_replay from public.predictions where idempotency_key = p_idempotency_key;
  if found then
    return (v_replay, 'replayed')::public.set_pick_result;
  end if;

  -- Authoritative, live, in-transaction eligibility: join through to the
  -- canonical Game every single call, never trust a caller-supplied
  -- kickoff/status value.
  select f.internal_status, f.scheduled_start_utc
    into v_fixture_status, v_scheduled_start
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = p_market_id;

  if not found then
    raise exception 'market_not_found';
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  -- Lock any existing row for this user+market for the rest of this
  -- transaction — the same primitive a future R7 acceptance operation
  -- must also acquire before it may set lock_reason='CHALLENGE_ACCEPTED',
  -- so an edit and a future accept can never both believe they won.
  select * into v_existing from public.predictions where user_id = p_user_id and market_id = p_market_id for update;

  if not found then
    -- Creating a brand new Pick: fail-safe Game-status check (§20) plus
    -- the live cutoff check. Nothing exists yet to materialize a lock
    -- onto, so a clean reject with no row is correct here.
    if v_fixture_status <> 'NOT_STARTED' then
      return (null, 'rejected_game_closed')::public.set_pick_result;
    end if;
    if now() >= v_effective_lock_at then
      return (null, 'rejected_cutoff')::public.set_pick_result;
    end if;

    -- SELECT ... FOR UPDATE above cannot lock a row that doesn't exist yet
    -- (the classic Postgres "phantom row" gap) — two concurrent calls can
    -- both reach here believing they're first. The INSERT's own
    -- predictions_one_per_user_market constraint is the real backstop:
    -- caught explicitly below (verified necessary by direct concurrency
    -- testing during this migration's own development — the earlier,
    -- exception-free version of this branch let a raw unique-violation
    -- escape uncaught). The loser simply re-enters this same function —
    -- by the time it does, the winner's row is committed and visible, so
    -- the recursive call correctly takes the "existing row" branch below
    -- (idempotency-key replay if it was a true retry, or a normal
    -- edit/no-op/reject decision otherwise) instead of duplicating any of
    -- that logic here.
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

  -- An existing Pick that is already permanently locked or graded never
  -- becomes editable again, regardless of anything about the current
  -- moment (§17, §22, §32) — this check comes BEFORE any time/status
  -- re-evaluation on purpose.
  if v_existing.locked_at is not null or v_existing.lifecycle_state = 'GRADED' then
    return (v_existing, 'rejected_locked')::public.set_pick_result;
  end if;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    -- Lazily materialize the lock right now (§14, §31) — this Pick was
    -- effectively locked the moment the cutoff passed or the Game left
    -- NOT_STARTED, whether or not anything had touched it since. Reusing
    -- CUTOFF as the reason even for a Game-status change is deliberate:
    -- from this Pick's own perspective, ordinary editing simply stopped
    -- being available — the distinction between "time passed" and "Game
    -- state changed" is diagnostic, not a different structural reason.
    -- This UPDATE is a normal part of this function's single committed
    -- result now — no exception follows it, so it is never rolled back.
    update public.predictions set locked_at = least(now(), v_effective_lock_at), lock_reason = 'CUTOFF', updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.set_pick_result;
  end if;

  if v_existing.selected_outcome = p_selected_outcome then
    -- Idempotent no-op (§26): the same selection, resubmitted. No
    -- revision row, no probability re-snapshot, no update at all.
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
$$;

revoke all on function public.set_pick(uuid, uuid, text, numeric, numeric, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.set_pick(uuid, uuid, text, numeric, numeric, text, timestamptz, text, text) to service_role;

-- predictions itself: client roles must never be able to mutate
-- selected_outcome/probabilities/locked_at/lock_reason/result/graded_at
-- directly (§39-40) — no INSERT/UPDATE grant to authenticated existed
-- before R5 and none is added now. Every write, create or edit, goes
-- through set_pick() (or markPredictionGraded's own existing, unchanged
-- grading path) via the service-role admin client.
