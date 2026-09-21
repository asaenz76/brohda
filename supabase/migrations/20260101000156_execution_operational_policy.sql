-- Milestone 5.5 operational policy — reuses the `platform_settings`
-- singleton exactly as Milestone 5 already established for simulation
-- policy (migration 20260101000149), rather than a new framework, for the
-- values that are genuinely singleton/global rather than scoped-per-row
-- (circuit-breaker thresholds, rollout mode default, compliance-state
-- tolerance). Scoped policy (kill switches, cohorts, limits) lives in its
-- own dedicated tables (migration 20260101000153) — see
-- docs/architecture/execution-operational-safety.md §"Configuration model"
-- for the full data-shape reasoning.
alter table public.platform_settings
  -- Circuit breaker (lib/execution/provider-health.ts). None of these are
  -- domain invariants — an operator may need to loosen/tighten them without
  -- a deploy, exactly like Milestone 5's own rate-limit remediation lesson.
  add column execution_circuit_breaker_failure_threshold integer not null default 5,
  add column execution_circuit_breaker_observation_window_seconds integer not null default 60,
  add column execution_circuit_breaker_cooldown_seconds integer not null default 30,
  add column execution_circuit_breaker_half_open_max_probes integer not null default 1,

  -- Whether SIMULATION eligibility tolerates an UNKNOWN compliance signal
  -- (jurisdiction/KYC/AML/sanctions/age — none of which Milestone 5.5
  -- resolves). Simulation has no real financial exposure, so this may
  -- reasonably default permissive; a future real-execution path must NOT
  -- read this column at all — its own fail-closed-on-UNKNOWN behavior is a
  -- true invariant, never sourced from configuration. See
  -- lib/execution/eligibility.ts.
  add column execution_simulation_tolerate_unknown_compliance boolean not null default true,

  -- Rollout mode: OPEN means every eligible user may proceed regardless of
  -- cohort membership (today's Milestone 5 behavior, unchanged);
  -- COHORT_RESTRICTED means only members of an active, enabled cohort may
  -- proceed. An operator flips this without a deploy once cohorts are
  -- actually populated.
  add column execution_rollout_mode text not null default 'OPEN' check (execution_rollout_mode in ('OPEN', 'COHORT_RESTRICTED')),

  -- Reconciliation: how many consecutive MISMATCH results for the same
  -- order intent escalate to MANUAL_REVIEW_REQUIRED instead of remaining a
  -- plain MISMATCH (STEP 23/25).
  add column execution_reconciliation_manual_review_after_mismatches integer not null default 2;

alter table public.platform_settings
  add constraint execution_circuit_breaker_failure_threshold_positive check (execution_circuit_breaker_failure_threshold > 0),
  add constraint execution_circuit_breaker_observation_window_seconds_positive check (execution_circuit_breaker_observation_window_seconds > 0),
  add constraint execution_circuit_breaker_cooldown_seconds_positive check (execution_circuit_breaker_cooldown_seconds > 0),
  add constraint execution_circuit_breaker_half_open_max_probes_positive check (execution_circuit_breaker_half_open_max_probes > 0),
  add constraint execution_reconciliation_manual_review_after_mismatches_positive check (execution_reconciliation_manual_review_after_mismatches > 0);

comment on column public.platform_settings.execution_circuit_breaker_failure_threshold is
  'Milestone 5.5: consecutive read failures within the observation window before the execution circuit breaker opens for a provider.';
comment on column public.platform_settings.execution_circuit_breaker_observation_window_seconds is
  'Milestone 5.5: the sliding window (seconds) over which consecutive failures are counted toward the failure threshold.';
comment on column public.platform_settings.execution_circuit_breaker_cooldown_seconds is
  'Milestone 5.5: how long an OPEN circuit breaker waits before allowing a HALF_OPEN probe.';
comment on column public.platform_settings.execution_circuit_breaker_half_open_max_probes is
  'Milestone 5.5: how many successful probes a HALF_OPEN breaker needs before closing again.';
comment on column public.platform_settings.execution_simulation_tolerate_unknown_compliance is
  'Milestone 5.5: whether SIMULATION eligibility tolerates an UNKNOWN jurisdiction/KYC/AML/sanctions/age signal. Never read by real execution, which always fails closed on UNKNOWN as a code-level invariant.';
comment on column public.platform_settings.execution_rollout_mode is
  'Milestone 5.5: OPEN (everyone eligible regardless of cohort) or COHORT_RESTRICTED (only active cohort members proceed).';
comment on column public.platform_settings.execution_reconciliation_manual_review_after_mismatches is
  'Milestone 5.5: consecutive MISMATCH results for the same order intent before reconciliation escalates to MANUAL_REVIEW_REQUIRED.';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050).
