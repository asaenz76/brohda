-- Prediction Network transformation, Milestone 3 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
-- Milestone 3 — Brohda Prediction Layer). Additive only — no legacy pool,
-- entry, settlement, or Milestone 1/2 market/taxonomy table is touched or
-- referenced by FK.
--
-- A Brohda Prediction is a permanent record of what a user believed about a
-- market at a specific moment. It is not an order, trade, position, or
-- wallet transaction, and creates no financial exposure (roadmap §3).
--
-- Market identity preservation strategy (roadmap §3's deferred decision,
-- made here): `market_id` is a plain uuid, deliberately NOT a foreign key —
-- the same preservation pattern this codebase already uses for
-- `audit_logs`/`wallet_transactions` (plain uuid references to business
-- entities, so permanent history survives the referenced row's own
-- lifecycle). Milestone 1's `markets` rows are never deleted (only
-- upserted in place), so `market_id` remains a reliable lookup key for
-- "what does this market look like today" — but a bare FK would still make
-- history only as durable as that row's continued existence, provider
-- migration, or a future schema change. The `*_snapshot` columns below are
-- the actual source of historical truth: a Prediction remains fully
-- meaningful for history/grading display even if the referenced market row
-- is later archived, restructured, or (in a future milestone) deleted.
--
-- See docs/architecture/prediction-layer.md for the full design rationale.
create table public.predictions (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.user_profiles (id) on delete cascade,

  -- Soft reference only — see header comment. Never a foreign key.
  market_id                   uuid not null,

  -- The user's belief. Immutable after creation.
  selected_outcome            text not null check (selected_outcome in ('YES', 'NO')),

  -- Immutable snapshot of what Brohda's own normalized data showed at the
  -- moment the prediction was accepted — never re-derived, never backfilled
  -- from a later market state. 0-1 range, matching Milestone 1's
  -- NormalizedMarketPrice. Independently captured, exactly like Milestone 1
  -- never derives one side's price from the other.
  yes_probability_snapshot    numeric not null check (yes_probability_snapshot >= 0 and yes_probability_snapshot <= 1),
  no_probability_snapshot     numeric not null check (no_probability_snapshot >= 0 and no_probability_snapshot <= 1),

  -- Immutable market/question snapshot — the durable part of "market
  -- identity" that survives the referenced row changing shape later.
  market_question_snapshot    text not null,
  market_close_at_snapshot    timestamptz,
  -- Brohda's own provider-neutral consumer status (ACTIVE/CLOSED/RESOLVED,
  -- lib/prediction-markets/discovery/types.ts's ConsumerMarketStatus) at
  -- prediction time — never a raw provider status string.
  market_status_snapshot      text not null check (market_status_snapshot in ('ACTIVE', 'CLOSED', 'RESOLVED')),

  -- Lifecycle: distinct from the user's selected_outcome and from the
  -- eventual resolved_outcome_snapshot. A Prediction exists in PENDING from
  -- the moment it's created; grading is the only path to GRADED, and
  -- grading is one-way (see docs/architecture/prediction-layer.md's
  -- correction/reversal limitations).
  lifecycle_state             text not null default 'PENDING' check (lifecycle_state in ('PENDING', 'GRADED')),
  -- Correctness is distinct from both selected_outcome and
  -- resolved_outcome_snapshot — it's their comparison, computed once at
  -- grading time and stored (not re-derived on every read) so a later
  -- provider correction can never silently change a user's history.
  result                      text check (result in ('CORRECT', 'INCORRECT', 'VOID')),
  -- The market's resolved outcome AS OBSERVED AT GRADING TIME. Kept
  -- separate from the prediction-time snapshot fields above — this one is
  -- allowed to exist only from grading onward, never backfilled earlier.
  resolved_outcome_snapshot   text check (resolved_outcome_snapshot in ('YES', 'NO')),
  graded_at                   timestamptz,

  -- Technical duplicate-submission protection only (double-click/retry) —
  -- NOT how "one active prediction per market" policy is enforced (that's
  -- application-level, reading configurable policy, so it can change
  -- without a migration; see docs/architecture/prediction-layer.md).
  idempotency_key             text not null,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint predictions_result_requires_graded
    check (
      (lifecycle_state = 'PENDING' and result is null and resolved_outcome_snapshot is null and graded_at is null)
      or
      (lifecycle_state = 'GRADED' and result is not null and graded_at is not null)
    ),
  -- A VOID grading (market never reached a trustworthy resolution, e.g. it
  -- was archived first) has no resolved outcome to compare against.
  constraint predictions_correctness_matches_outcome
    check (
      result is null
      or (result = 'VOID' and resolved_outcome_snapshot is null)
      or (result in ('CORRECT', 'INCORRECT') and resolved_outcome_snapshot is not null)
    )
);

create unique index predictions_idempotency_key_key on public.predictions (idempotency_key);
create index predictions_user_id_created_at_idx on public.predictions (user_id, created_at desc);
create index predictions_market_id_idx on public.predictions (market_id);
-- The grading job's own query shape: find work, in creation order.
create index predictions_lifecycle_state_idx on public.predictions (lifecycle_state) where lifecycle_state = 'PENDING';

comment on table public.predictions is
  'Permanent Brohda Prediction records (Milestone 3). market_id is a soft reference, not a foreign key — see column/table comments and docs/architecture/prediction-layer.md.';
comment on column public.predictions.market_id is
  'References public.markets(id) informally. Deliberately not a foreign key, so history survives independently of that row''s own lifecycle. See docs/architecture/prediction-layer.md.';

-- RLS: a user may read only their own Predictions in this milestone (public
-- history is deferred, not built partially — see docs/architecture/
-- prediction-layer.md). No `for insert`/`for update` policy exists for
-- `authenticated` at all, matching this codebase's own established
-- convention (e.g. team_follows, entries): RLS restricts reads, and all
-- writes go through a Server Action's service-role client, authorized by
-- requireUser() in the action itself, never by an RLS INSERT policy.
alter table public.predictions enable row level security;

create policy "select_own_predictions"
on public.predictions for select
to authenticated
using (user_id = auth.uid());

grant select on public.predictions to authenticated;
grant select, insert, update, delete on public.predictions to service_role;
