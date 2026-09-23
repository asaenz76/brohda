-- Prediction Network transformation, Milestone 2 hard-coding audit
-- (standing rule: "hard-code invariants, configure policy"). Freshness
-- thresholds were initially written as a code constant
-- (lib/prediction-markets/discovery/policy.ts); on review this is
-- genuinely CONFIGURABLE OPERATIONAL POLICY (an operator may reasonably
-- want to loosen/tighten staleness tolerance without a deploy, e.g. if
-- ingestion cadence changes), not a domain invariant. Rather than inventing
-- a new settings table/framework, this reuses the existing
-- `platform_settings` singleton — the same pattern already established for
-- registration_enabled and (Milestone 1-era) paid/free pool toggles — which
-- is exactly the "reuse existing admin patterns, avoid unnecessary generic
-- configuration frameworks" balance both the milestone's own instructions
-- and the standing hard-coding rule call for.
--
-- Defaults match the values the code constant previously held (60 minutes /
-- 24 hours) — this migration changes WHERE the policy lives, not its
-- current effective value.

alter table public.platform_settings
  add column discovery_fresh_within_minutes integer not null default 60,
  add column discovery_stale_within_minutes integer not null default 1440;

-- No grant/RLS change needed — `platform_settings` is already readable by
-- anon/authenticated ("anyone can read platform settings", 20260101000050)
-- and writable only by service_role. These two new columns inherit that
-- exact same posture automatically.
