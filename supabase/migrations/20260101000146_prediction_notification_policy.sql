-- Milestone 3 final standing-rule remediation — Prediction grading
-- notification policy. `prediction_graded` notification behavior was
-- previously hard-coded (fires unconditionally, VOID always notifies) and
-- justified only by "no other notification type in this codebase is
-- configurable either" — existing precedent is not proof of invariance,
-- and whether/which grading results notify is genuinely mutable product
-- policy, not a domain invariant. Fixed the same way every other Milestone
-- 3 policy knob was: reusing the existing `platform_settings` singleton
-- (migration 20260101000142's own precedent), not a new table or
-- framework — a plain, non-executable enabled/per-result-boolean model,
-- not a generic rules engine.
--
-- Defaults reproduce current Milestone 3 behavior exactly (enabled;
-- CORRECT, INCORRECT, and VOID all notify) — this migration changes WHERE
-- the policy lives, not its current effective value.
alter table public.platform_settings
  add column prediction_notifications_enabled boolean not null default true,
  add column prediction_notify_on_correct boolean not null default true,
  add column prediction_notify_on_incorrect boolean not null default true,
  add column prediction_notify_on_void boolean not null default true;

comment on column public.platform_settings.prediction_notifications_enabled is
  'Milestone 3 grading notification policy: master on/off switch for prediction_graded notifications. See docs/architecture/prediction-layer.md.';
comment on column public.platform_settings.prediction_notify_on_correct is
  'Milestone 3 grading notification policy: whether a CORRECT grading result sends a notification.';
comment on column public.platform_settings.prediction_notify_on_incorrect is
  'Milestone 3 grading notification policy: whether an INCORRECT grading result sends a notification.';
comment on column public.platform_settings.prediction_notify_on_void is
  'Milestone 3 grading notification policy: whether a VOID grading result sends a notification.';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050);
-- these new columns inherit that posture automatically, same as every
-- prior platform_settings extension in this codebase.
