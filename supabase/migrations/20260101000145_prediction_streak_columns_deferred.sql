-- Milestone 3 final standing-rule remediation, Finding 2. On re-review,
-- current_streak/best_streak are not factual aggregates the way
-- correct/incorrect counts are — they embed real, undecided product
-- policy (does INCORRECT reset the streak? does VOID preserve it? is the
-- sequence ordered by prediction time or grading time?), which is exactly
-- what docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 8 reserves for
-- founder-reviewed design, not something Milestone 3 should have silently
-- decided. See lib/predictions/streak.ts's own comment for the full
-- reasoning.
--
-- Per the roadmap's own locked "additive migration before destructive
-- migration, always" principle, these two columns (added in
-- 20260101000142) are NOT dropped here — only their intended ownership is
-- corrected in schema metadata. No application code reads or writes them
-- as of this migration; they remain at their default of 0, reserved for
-- Milestone 8 to adopt (with a real streak definition) or formally
-- retire.
comment on column public.user_profiles.prediction_current_streak is
  'Deferred to roadmap Milestone 8 (Milestone 3 final standing-rule remediation, Finding 2) — streak definition is undecided product policy, not a factual aggregate. Not written or read by any Milestone 3 code; stays at its default of 0.';
comment on column public.user_profiles.prediction_best_streak is
  'Deferred to roadmap Milestone 8 (Milestone 3 final standing-rule remediation, Finding 2) — same reasoning as prediction_current_streak. Not written or read by any Milestone 3 code; stays at its default of 0.';
