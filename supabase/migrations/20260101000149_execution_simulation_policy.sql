-- Milestone 5 (Simulated Execution) policy configuration. Every one of
-- these is genuinely mutable product/operational policy per the standing
-- rule — none is a domain invariant — reusing the existing
-- `platform_settings` singleton exactly as Milestones 2/3 already
-- established, rather than a new framework. See
-- docs/architecture/simulated-execution.md for the full hard-coding audit.
alter table public.platform_settings
  add column execution_simulation_enabled boolean not null default true,
  -- Amounts are cents integers, matching this codebase's existing
  -- entry-fee-cents convention (avoids floating-point currency bugs).
  add column execution_min_amount_cents integer not null default 100,
  add column execution_max_amount_cents integer not null default 100000,
  -- Milestone 4 explicitly treats financial execution as higher-risk than
  -- discovery — this is a SEPARATE, stricter freshness window from
  -- discovery's own `discovery_fresh_within_minutes` (measured in minutes);
  -- execution's is measured in seconds on purpose.
  add column execution_quote_expiry_seconds integer not null default 30,
  add column execution_data_freshness_max_seconds integer not null default 10,
  add column execution_max_slippage_bps integer not null default 500,
  -- How much the effective price may move between quote creation and
  -- confirmation before the confirmation is rejected rather than silently
  -- honored or silently re-priced (roadmap-adjacent decision, Milestone 5
  -- STEP 25).
  add column execution_recalculation_tolerance_bps integer not null default 200,
  -- Simulated fee ASSUMPTIONS, not real provider data (Milestone 1's own
  -- research never confirmed a live-readable exact provider fee; Milestone
  -- 4's research confirmed only the builder-fee CAP, not Brohda's actual
  -- rate). Explicitly labeled simulated wherever rendered — see
  -- lib/execution/quote-math.ts.
  add column execution_simulated_provider_fee_bps integer not null default 100,
  add column execution_simulated_brohda_fee_bps integer not null default 0;

comment on column public.platform_settings.execution_simulation_enabled is
  'Milestone 5: master on/off switch for the simulated execution feature. No real financial exposure exists regardless of this value.';
comment on column public.platform_settings.execution_min_amount_cents is
  'Milestone 5: minimum simulated execution amount, in cents.';
comment on column public.platform_settings.execution_max_amount_cents is
  'Milestone 5: maximum simulated execution amount, in cents.';
comment on column public.platform_settings.execution_quote_expiry_seconds is
  'Milestone 5: how long a simulated Quote remains confirmable after creation.';
comment on column public.platform_settings.execution_data_freshness_max_seconds is
  'Milestone 5: maximum age (seconds) of the underlying provider order-book snapshot for a Quote to be considered trustworthy. Deliberately stricter and separately configurable from discovery''s own freshness policy.';
comment on column public.platform_settings.execution_max_slippage_bps is
  'Milestone 5: maximum simulated slippage (basis points) a Quote may show before eligibility fails.';
comment on column public.platform_settings.execution_recalculation_tolerance_bps is
  'Milestone 5: maximum price movement (basis points) tolerated between Quote creation and confirmation before the confirmation is rejected.';
comment on column public.platform_settings.execution_simulated_provider_fee_bps is
  'Milestone 5: SIMULATED provider fee assumption (basis points) — not real provider fee data. Always labeled as simulated/estimated to the consumer.';
comment on column public.platform_settings.execution_simulated_brohda_fee_bps is
  'Milestone 5: SIMULATED/hypothetical Brohda fee (basis points). No real fee is charged in Milestone 5.';

-- No grant/RLS change needed — platform_settings is already readable by
-- anon/authenticated and writable only by service_role (20260101000050);
-- these new columns inherit that posture automatically.
