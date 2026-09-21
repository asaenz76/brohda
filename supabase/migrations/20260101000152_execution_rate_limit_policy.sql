-- Milestone 5 final remediation: the quote/confirmation rate-limit
-- window/max-attempt values were originally hard-coded constants in
-- lib/rate-limit/execution.ts. Per the standing hard-coding rule, "centralized
-- in one file" is not the same as "genuinely invariant" — these are mutable
-- operational policy (an operator may legitimately need to loosen or
-- tighten either class, or turn one off, without a deploy), so they move
-- into the same `platform_settings` singleton Milestone 5 already uses for
-- simulation policy (migration 20260101000149), rather than a new
-- generic rate-limiting framework.
--
-- What stays code-level (architectural/security behavior, not policy):
--   - quote requests fail OPEN if the rate-limit backend itself errors
--   - confirmation requests fail CLOSED if the rate-limit backend errors
--   - enforcement happens server-side; the client cannot supply its own limit
-- See lib/rate-limit/execution.ts for where that invariant behavior lives.
alter table public.platform_settings
  add column execution_quote_rate_limit_enabled boolean not null default true,
  add column execution_quote_rate_limit_window_seconds integer not null default 60,
  add column execution_quote_rate_limit_max_attempts integer not null default 30,
  add column execution_confirmation_rate_limit_enabled boolean not null default true,
  add column execution_confirmation_rate_limit_window_seconds integer not null default 60,
  add column execution_confirmation_rate_limit_max_attempts integer not null default 10;

alter table public.platform_settings
  add constraint execution_quote_rate_limit_window_seconds_positive check (execution_quote_rate_limit_window_seconds > 0),
  add constraint execution_quote_rate_limit_max_attempts_positive check (execution_quote_rate_limit_max_attempts > 0),
  add constraint execution_confirmation_rate_limit_window_seconds_positive check (execution_confirmation_rate_limit_window_seconds > 0),
  add constraint execution_confirmation_rate_limit_max_attempts_positive check (execution_confirmation_rate_limit_max_attempts > 0);

comment on column public.platform_settings.execution_quote_rate_limit_enabled is
  'Milestone 5: whether quote-request rate limiting is enforced at all. Disabling does not disable simulation itself, only this one guardrail.';
comment on column public.platform_settings.execution_quote_rate_limit_window_seconds is
  'Milestone 5: quote-request rate-limit sliding window, in seconds. Default reproduces the original hard-coded value.';
comment on column public.platform_settings.execution_quote_rate_limit_max_attempts is
  'Milestone 5: maximum quote requests allowed per window per user. Default reproduces the original hard-coded value.';
comment on column public.platform_settings.execution_confirmation_rate_limit_enabled is
  'Milestone 5: whether confirmation rate limiting is enforced at all. This is the fail-CLOSED class — disabling it is an explicit operator choice, never a side effect of missing configuration.';
comment on column public.platform_settings.execution_confirmation_rate_limit_window_seconds is
  'Milestone 5: confirmation rate-limit sliding window, in seconds. Default reproduces the original hard-coded value.';
comment on column public.platform_settings.execution_confirmation_rate_limit_max_attempts is
  'Milestone 5: maximum confirmations allowed per window per user. Default reproduces the original hard-coded value.';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050);
-- these new columns inherit that posture automatically.
