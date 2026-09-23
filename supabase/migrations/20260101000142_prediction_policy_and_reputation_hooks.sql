-- Prediction Network transformation, Milestone 3 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
-- Milestone 3 — Brohda Prediction Layer). Additive only.
--
-- Part 1 — Prediction eligibility/policy configuration. Per the standing
-- hard-coding rule, every one of these is genuinely mutable product policy
-- (a founder could reasonably change it without a deploy), not a domain
-- invariant, so none of it lives in application code. Reusing the existing
-- `platform_settings` singleton — the same pattern Milestone 2 already
-- established for discovery freshness thresholds — rather than a new
-- framework. See docs/architecture/prediction-layer.md for the full
-- hard-coding audit and why each of these five (and no more) was judged
-- load-bearing enough to configure now.
alter table public.platform_settings
  -- Whether a user may submit more than one Prediction on the same market.
  -- Default false: one active belief per user per market, matching the
  -- simplest consumer behavior (roadmap-adjacent decision made explicitly
  -- here, not assumed). When true, a repeated submission creates a new,
  -- separate, immutable Prediction row rather than editing the prior one —
  -- see docs/architecture/prediction-layer.md's immutability/history design.
  add column prediction_allow_repeat boolean not null default false,
  -- Minutes before a market's close time at which new Predictions stop
  -- being accepted, on top of the market simply being ACTIVE. 0 = no
  -- additional cutoff.
  add column prediction_cutoff_minutes_before_close integer not null default 0,
  -- Whether a market whose price data is STALE (per the existing Milestone 2
  -- freshness policy) may still be predicted on.
  add column prediction_allow_stale_price boolean not null default true,
  -- Whether a market with no usable price at all (UNAVAILABLE) may still be
  -- predicted on. Default false: a belief snapshot needs a real number to
  -- snapshot.
  add column prediction_allow_unavailable_price boolean not null default false,
  -- Whether a CLOSED-but-not-yet-RESOLVED market may still be predicted on.
  -- Default false. (A RESOLVED market is never predictable regardless of
  -- this flag — that's a true invariant, not policy: predicting on an
  -- already-known outcome isn't a prediction. See lib/predictions/policy.ts.)
  add column prediction_allow_closed_market boolean not null default false;

comment on column public.platform_settings.prediction_allow_repeat is
  'Milestone 3 prediction policy: may a user submit more than one Prediction on the same market? See docs/architecture/prediction-layer.md.';
comment on column public.platform_settings.prediction_cutoff_minutes_before_close is
  'Milestone 3 prediction policy: minutes before market close at which new Predictions stop being accepted.';
comment on column public.platform_settings.prediction_allow_stale_price is
  'Milestone 3 prediction policy: may a STALE-priced market still be predicted on?';
comment on column public.platform_settings.prediction_allow_unavailable_price is
  'Milestone 3 prediction policy: may a market with no usable price still be predicted on?';
comment on column public.platform_settings.prediction_allow_closed_market is
  'Milestone 3 prediction policy: may a CLOSED-but-unresolved market still be predicted on?';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050);
-- these new columns inherit that posture automatically, same as
-- migration 138 before this one.

-- Part 2 — basic, factual Prediction-domain reputation hooks (roadmap
-- STEP 22 / this task's own STEP 22: minimum hooks only, no algorithm, no
-- weighting, no leaderboard-inclusion logic).
--
-- Deliberately NEW, separate columns from user_profiles' existing
-- correct_predictions_count/current_streak/best_streak
-- (20260101000018_leaderboard.sql) — those are written exclusively by the
-- LEGACY pool-entry settlement path. Writing Milestone 3 grading results
-- into the same counters would silently blend two different domains'
-- outcomes into one number, which this task's own instructions explicitly
-- forbid ("keep code/domain boundaries explicit... do not cross-write
-- between them"). Same pattern (plain integer counters on user_profiles),
-- new columns, so the two domains can coexist without corrupting each
-- other, per roadmap §6/§8 legacy-coexistence.
alter table public.user_profiles
  add column prediction_correct_count integer not null default 0,
  add column prediction_incorrect_count integer not null default 0,
  add column prediction_current_streak integer not null default 0,
  add column prediction_best_streak integer not null default 0;

comment on column public.user_profiles.prediction_correct_count is
  'Milestone 3 Prediction-domain correct count. Separate from the legacy pool-entry correct_predictions_count — never cross-written. Updated only by the grading job.';
comment on column public.user_profiles.prediction_current_streak is
  'Milestone 3 Prediction-domain current streak. Separate from the legacy pool-entry current_streak — never cross-written. Updated only by the grading job.';

-- No grant/RLS change needed — user_profiles' existing read posture already
-- covers these new columns identically to every other profile-stat column.
