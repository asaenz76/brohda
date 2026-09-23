-- Milestone R7 (docs/BROHDA_2_0_MILESTONE_MAP.md, Free Call BS Challenges).
-- Additive only. Makes reachable the `lock_reason = 'CHALLENGE_ACCEPTED'`
-- seam R5 deliberately reserved (20260101000152_pick_editing_and_locking.sql)
-- without touching set_pick() itself, predictions' shape, or any R1-R6
-- migration. No wallet/stake/monetary schema — see the table's own column
-- list, which has none.

-- `market_id` is a plain, deliberate soft reference — same reasoning
-- `predictions.market_id` already established (docs/architecture/
-- prediction-layer.md §4): a Challenge is permanent head-to-head history,
-- and its durability should never depend on `markets` never being
-- restructured. `challenger_prediction_id`/`recipient_prediction_id` ARE
-- real (non-cascading) FKs to `predictions.id` — mirroring
-- `prediction_revisions.prediction_id`'s own precedent exactly, since
-- `predictions` rows are themselves never deleted by any code path, so a
-- real FK here gives genuine integrity at no durability cost.
create table public.challenges (
  id                          uuid primary key default gen_random_uuid(),
  market_id                   uuid not null,
  challenger_user_id          uuid not null references public.user_profiles (id) on delete cascade,
  recipient_user_id           uuid not null references public.user_profiles (id) on delete cascade,
  challenger_prediction_id    uuid not null references public.predictions (id),
  recipient_prediction_id     uuid not null references public.predictions (id),

  -- Milestone R7 §18: the challenged selections, captured immutably at
  -- Challenge creation — never re-derived from predictions.selected_outcome
  -- later, since that field is mutable pre-lock (R5). Acceptance revalidates
  -- current Pick state against these snapshots (§17, §21).
  challenger_selection_snapshot text not null check (challenger_selection_snapshot in ('YES', 'NO')),
  recipient_selection_snapshot  text not null check (recipient_selection_snapshot in ('YES', 'NO')),

  -- Lifecycle stage and outcome are two orthogonal columns, not one
  -- overloaded enum (§14's own "do not overload one boolean" instruction,
  -- extended here to "or one overloaded status"). RESOLVED covers both a
  -- real winner and a VOID market/Pick result — §34's "void/unresolved
  -- outcome where appropriate" is a sub-case of "resolved," not a separate
  -- top-level lifecycle stage.
  status                      text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESOLVED')),
  result                      text check (result in ('CHALLENGER_WON', 'RECIPIENT_WON', 'VOID')),

  accepted_at                 timestamptz,
  declined_at                 timestamptz,
  resolved_at                 timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint challenges_different_users check (challenger_user_id <> recipient_user_id),
  constraint challenges_different_picks check (challenger_prediction_id <> recipient_prediction_id),
  constraint challenges_selections_oppose check (challenger_selection_snapshot <> recipient_selection_snapshot),
  constraint challenges_accepted_at_shape check ((status in ('ACCEPTED', 'RESOLVED')) = (accepted_at is not null)),
  constraint challenges_declined_at_shape check ((status = 'DECLINED') = (declined_at is not null)),
  constraint challenges_result_shape check ((status = 'RESOLVED') = (result is not null and resolved_at is not null))
);

create index idx_challenges_challenger on public.challenges (challenger_user_id, created_at desc);
create index idx_challenges_recipient on public.challenges (recipient_user_id, created_at desc);
create index idx_challenges_market on public.challenges (market_id);
create index idx_challenges_status_accepted on public.challenges (status) where status = 'ACCEPTED';

-- Milestone R7 §25-26: structural (not merely app-level) prevention of a
-- duplicate PENDING Challenge between the same two Picks — in EITHER
-- direction. A partial unique index on the *unordered* pair
-- (least, greatest) of the two prediction ids makes André→Carlos and a
-- later Carlos→André both collide with the same still-PENDING row, while a
-- previous Challenge that reached a terminal state (DECLINED/EXPIRED/
-- RESOLVED) never blocks a legitimate new one (§25's own explicit
-- requirement) — the index only applies `where status = 'PENDING'`.
create unique index challenges_one_pending_pair
  on public.challenges (least(challenger_prediction_id, recipient_prediction_id), greatest(challenger_prediction_id, recipient_prediction_id))
  where status = 'PENDING';

alter table public.challenges enable row level security;

-- Participants always see their own Challenges (every lifecycle stage,
-- including private PENDING negotiation). A RESOLVED Challenge is also a
-- public factual record (§38, §48 — "the raw head-to-head result R11 will
-- consume", surfaced e.g. as Call BS win/loss history) — visible to any
-- authenticated user once resolved. Two separate, independently-documented
-- permissive policies rather than one policy trying to express both
-- reasons at once.
create policy "participants_can_read_own_challenges" on public.challenges for select to authenticated
  using (challenger_user_id = auth.uid() or recipient_user_id = auth.uid());

create policy "resolved_challenges_are_public_record" on public.challenges for select to authenticated
  using (status = 'RESOLVED');

-- No INSERT/UPDATE/DELETE grant to authenticated at all — every lifecycle
-- transition goes through call_bs()/accept_call_bs()/decline_call_bs()
-- (service-role RPCs) or the resolution job's own service-role update,
-- matching every other domain table this codebase already established.
grant select on public.challenges to authenticated;
grant select, insert, update on public.challenges to service_role;

-- Milestone R7 configuration (§59-60). `call_bs_enabled` follows the same
-- off-by-default-until-deliberately-turned-on convention already used for
-- `post_publication_enabled`/`community_distribution_enabled`/
-- `market_ingestion_enabled` — a brand-new user-facing mechanic, not a
-- policy tweak to an existing one. Deliberately NO separate Challenge
-- cutoff column: §11 asked for "the smallest coherent architecture", and a
-- Challenge cannot remain accept-able after ordinary Pick mutability has
-- closed (§11's own stated invariant) is satisfied STRUCTURALLY, not by
-- convention, by reusing platform_settings.pick_lock_minutes_before_kickoff
-- directly for Challenge creation/acceptance eligibility too — the two
-- cutoffs cannot drift apart because they are the same read.
alter table public.platform_settings
  add column call_bs_enabled boolean not null default false,
  add column call_bs_rate_limit_window_seconds integer not null default 60 check (call_bs_rate_limit_window_seconds >= 1),
  add column call_bs_rate_limit_max_attempts integer not null default 10 check (call_bs_rate_limit_max_attempts >= 1);

comment on column public.platform_settings.call_bs_enabled is
  'Whether a new Call BS Challenge may be created. Off by default, matching post_publication_enabled/community_distribution_enabled''s own convention for a new mechanic. Does not affect an already-PENDING/ACCEPTED Challenge''s own lifecycle (accept/decline/resolve) if later disabled.';
comment on column public.platform_settings.call_bs_rate_limit_window_seconds is
  'Call BS creation rate-limit window, read live by lib/rate-limit/challenges.ts.';
comment on column public.platform_settings.call_bs_rate_limit_max_attempts is
  'Call BS creation rate-limit attempt cap within the configured window.';

-- Link a notification to its Challenge (mirrors notifications.pool_id /
-- notifications.post_id's own real, non-cascading, nullable-FK
-- convention exactly).
alter table public.notifications add column challenge_id uuid references public.challenges (id);

comment on column public.challenges.market_id is
  'Soft reference to markets.id — same durability reasoning as predictions.market_id (docs/architecture/prediction-layer.md §4). A Challenge is permanent head-to-head history and must survive independently of markets'' own lifecycle.';
comment on column public.challenges.status is
  'Lifecycle stage only. PENDING: awaiting recipient. ACCEPTED: both Picks locked, awaiting Market resolution. DECLINED: recipient refused. EXPIRED: became unacceptable before acceptance (cutoff passed, or the challenged disagreement no longer holds — see accept_call_bs()). RESOLVED: a final outcome (a winner, or VOID) is recorded in `result`.';
comment on column public.challenges.result is
  'Only set once status = RESOLVED. CHALLENGER_WON/RECIPIENT_WON derive deterministically from each Pick''s own canonical grading (predictions.result) — never computed independently. VOID means the underlying Market/Pick result never resolved to a trustworthy CORRECT/INCORRECT — no winner, nothing to refund (R7 has no money).';

-- =====================================================================
-- call_bs(): creates a PENDING Challenge (§9-13).
--
-- The ONLY client-meaningful input is the recipient's Pick id — everything
-- else (challenger's own Pick, the Market, both selection snapshots) is
-- derived server-side from authoritative state, never accepted from the
-- client (§9's own explicit instruction). p_challenger_user_id is the
-- authenticated caller's own id, supplied by the Server Action via
-- requireUser() — never client-choosable identity.
--
-- Plain exceptions for every rejection path here (not the (row, outcome)
-- composite set_pick() uses) — deliberately: unlike set_pick, no rejection
-- branch in this function needs to persist a partial write before failing
-- (nothing is materialized here that must survive a "no" answer), so the
-- lesson that drove set_pick's own composite-return design does not apply
-- (verified directly, same reasoning R6's add_post_comment/
-- remove_post_comment already applied).
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
begin
  select coalesce(call_bs_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'call_bs_disabled';
  end if;

  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  if not found then
    raise exception 'recipient_pick_not_found';
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
  -- column (§11's "smallest coherent architecture" decision — see this
  -- migration's own platform_settings comment above).
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
-- accept_call_bs(): the atomic acceptance transaction (§19-23).
--
-- (row, outcome) composite return, deliberately mirroring set_pick()'s own
-- pattern this time — unlike call_bs() above, this function DOES have a
-- "materialize a state change, then report failure" path (EXPIRED, on a
-- revalidation failure or a cutoff race lost) and a plain exception here
-- would roll that materialization back, repeating the exact bug R5's own
-- migration comment documents having caught by direct SQL testing.
--
-- Deterministic pick-lock order (§20-21): the two Pick rows are always
-- locked in ascending predictions.id order, regardless of which one is
-- "challenger" vs "recipient" for this particular call — so two
-- concurrent operations that both touch the same two rows (whether two
-- different accept_call_bs calls sharing one Pick, or an accept racing a
-- set_pick edit) can never acquire them in opposite order, which is what
-- would create a deadlock.
-- =====================================================================
create type public.accept_call_bs_result as (
  challenge public.challenges,
  outcome text
);

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
    -- §13, §22: authoritative current state decides, never a background
    -- job's own timing. Materialize the terminal state now, atomically,
    -- in the same statement group as this rejection.
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  -- Deterministic ascending-id lock order (§20) — see this function's own
  -- header comment.
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

  -- §21-22 race safety: a concurrent set_pick() edit or CUTOFF-lock that
  -- landed between our own cutoff check above and acquiring these row
  -- locks is caught here, now that we actually hold them. A pick already
  -- locked for a PRIOR accepted Challenge (lock_reason = 'CHALLENGE_ACCEPTED')
  -- is fine and expected (§56, §57's own multiplicity requirement) — only
  -- a CUTOFF lock (meaning ordinary Pick mutability already closed, which
  -- our own cutoff check above should have caught) invalidates acceptance.
  if (v_challenger_pred.lock_reason = 'CUTOFF') or (v_recipient_pred.lock_reason = 'CUTOFF') then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  -- §17, §21: revalidate current reality against the Challenge's own
  -- immutable snapshot — a Pick edit since creation invalidates the
  -- specific disagreement this Challenge names, even if the two sides
  -- still happen to oppose each other under some new combination.
  if v_challenger_pred.selected_outcome <> v_challenge.challenger_selection_snapshot
     or v_recipient_pred.selected_outcome <> v_challenge.recipient_selection_snapshot
     or v_challenger_pred.lifecycle_state = 'GRADED'
     or v_recipient_pred.lifecycle_state = 'GRADED'
  then
    update public.challenges set status = 'EXPIRED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  -- §56: never overwrite an existing compatible lock (e.g. this Pick was
  -- already CHALLENGE_ACCEPTED-locked by a different, earlier-accepted
  -- Challenge — §57's multiplicity case) — only set it when still null.
  update public.predictions
    set locked_at = now(), lock_reason = 'CHALLENGE_ACCEPTED', updated_at = now()
    where id in (v_challenger_pred.id, v_recipient_pred.id) and locked_at is null;

  update public.challenges set status = 'ACCEPTED', accepted_at = now(), updated_at = now()
    where id = v_challenge.id
    returning * into v_result;

  return (v_result, 'accepted')::public.accept_call_bs_result;
end;
$$;

revoke all on function public.accept_call_bs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_call_bs(uuid, uuid) to service_role;

-- =====================================================================
-- decline_call_bs(): §27. No Pick locking, no other side effect — a plain
-- one-way PENDING -> DECLINED transition, only the intended recipient may
-- perform it. Plain exceptions throughout: nothing here is materialized
-- before a possible rejection, so no atomicity hazard exists.
-- =====================================================================
create or replace function public.decline_call_bs(
  p_challenge_id uuid,
  p_recipient_user_id uuid
)
returns public.challenges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.challenges;
begin
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then
    raise exception 'challenge_not_found';
  end if;

  if v_challenge.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  if v_challenge.status <> 'PENDING' then
    raise exception 'not_pending';
  end if;

  update public.challenges set status = 'DECLINED', declined_at = now(), updated_at = now()
    where id = v_challenge.id
    returning * into v_challenge;

  return v_challenge;
end;
$$;

revoke all on function public.decline_call_bs(uuid, uuid) from public, anon, authenticated;
grant execute on function public.decline_call_bs(uuid, uuid) to service_role;
