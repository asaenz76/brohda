-- Prediction grading notification copy — CORRECT/INCORRECT/VOID
-- title/body templates were hard-coded in lib/notifications/predictions.ts's
-- copyForResult(). Consumer-facing wording that a founder could reasonably
-- want to reword without a deploy is mutable product policy, not a domain
-- invariant — the same reasoning already applied to notification
-- enablement/triggers (migration 20260101000146). Reuses the same
-- `platform_settings` singleton (the smallest existing mechanism — no new
-- table, no new RLS policy, no new grants) rather than a dedicated table.
--
-- `{{question}}` is a plain string placeholder, substituted by a literal
-- find-and-replace at send time (lib/notifications/predictions.ts) — never
-- evaluated as code or a template-expression language. Not a CMS: six
-- plain text columns, no rich content, no arbitrary logic.
--
-- Defaults reproduce the prior hard-coded wording exactly — this migration
-- changes WHERE the copy lives, not its current effective value.
alter table public.platform_settings
  add column prediction_notify_title_correct text not null default 'You were right',
  add column prediction_notify_body_correct text not null default 'Your prediction on "{{question}}" was correct.',
  add column prediction_notify_title_incorrect text not null default 'Result is in',
  add column prediction_notify_body_incorrect text not null default 'Your prediction on "{{question}}" was incorrect.',
  add column prediction_notify_title_void text not null default 'No result this time',
  add column prediction_notify_body_void text not null default '"{{question}}" didn''t reach a final result, so this prediction won''t count.';

comment on column public.platform_settings.prediction_notify_title_correct is
  'Milestone 3 grading notification copy: title shown for a CORRECT result. {{question}} is substituted with the prediction''s question text.';
comment on column public.platform_settings.prediction_notify_body_correct is
  'Milestone 3 grading notification copy: body shown for a CORRECT result. {{question}} is substituted with the prediction''s question text.';
comment on column public.platform_settings.prediction_notify_title_incorrect is
  'Milestone 3 grading notification copy: title shown for an INCORRECT result. {{question}} is substituted with the prediction''s question text.';
comment on column public.platform_settings.prediction_notify_body_incorrect is
  'Milestone 3 grading notification copy: body shown for an INCORRECT result. {{question}} is substituted with the prediction''s question text.';
comment on column public.platform_settings.prediction_notify_title_void is
  'Milestone 3 grading notification copy: title shown for a VOID result. {{question}} is substituted with the prediction''s question text.';
comment on column public.platform_settings.prediction_notify_body_void is
  'Milestone 3 grading notification copy: body shown for a VOID result. {{question}} is substituted with the prediction''s question text.';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050);
-- these new columns inherit that posture automatically, same as every
-- prior platform_settings extension in this codebase.
