-- Milestone 5.5 (Execution Controls, Reconciliation & Operational Safety,
-- docs/PRODUCT_TRANSFORMATION_ROADMAP.md). Provider-neutral operational
-- safety data — kill switches, rollout cohorts, and execution limits.
-- Additive only. No wallet, no Session Key, no provider credential, no
-- real order/fill/position — see docs/architecture/execution-operational-safety.md.
--
-- Deny-by-default posture throughout, exactly matching capability_policies
-- (20260101000140): these are purely operational/admin tables, no
-- authenticated-user policy exists at all — reads/writes happen only
-- through the service-role client, gated by the `manage_execution_controls`/
-- `manage_execution_rollout`/`view_execution_operations` capabilities.

-- ---------------------------------------------------------------------------
-- Kill switches
-- ---------------------------------------------------------------------------
-- One row per switch instance. Rows are never hard-deleted — "removing" a
-- switch sets enabled=false and records who/when, preserving the full
-- history in the row itself (STEP 29's audit requirement) in addition to
-- the execution_audit_events entry every mutation also writes
-- (lib/execution/kill-switches.ts).
create table public.execution_kill_switches (
  id             uuid primary key default gen_random_uuid(),

  -- The supported scope vocabulary is a closed domain capability (a true
  -- invariant — adding a new scope is a genuine application change, exactly
  -- like APP_CAPABILITIES's own hard-coded closed set). The scopes chosen
  -- are the ones the Milestone 4/6 readiness gate already named as
  -- justified: GLOBAL, PROVIDER, JURISDICTION, MARKET, USER, COHORT.
  scope          text not null check (scope in ('GLOBAL', 'PROVIDER', 'JURISDICTION', 'MARKET', 'USER', 'COHORT')),

  -- Soft reference whose meaning depends on scope: null for GLOBAL, a
  -- provider name for PROVIDER, a jurisdiction code for JURISDICTION, a
  -- market id (text, not uuid, to stay provider-neutral and avoid a real FK
  -- into markets) for MARKET, a user id for USER, a cohort key for COHORT.
  -- Never a foreign key, matching execution_quotes.market_id's own
  -- soft-reference convention.
  target         text,

  enabled        boolean not null default true,
  reason         text not null check (length(reason) > 0),
  note           text,

  created_by     uuid not null references public.user_profiles (id),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz,

  disabled_by    uuid references public.user_profiles (id),
  disabled_at    timestamptz,

  constraint execution_kill_switches_target_matches_scope check (
    (scope = 'GLOBAL' and target is null) or (scope != 'GLOBAL' and target is not null)
  ),
  constraint execution_kill_switches_disabled_consistency check (
    (enabled = true and disabled_at is null and disabled_by is null)
    or
    (enabled = false and disabled_at is not null)
  )
);

-- The lookup every control-plane evaluation performs: "is there an active,
-- unexpired switch for this exact scope/target". A partial index on the
-- common case (enabled = true) keeps this cheap even as history accumulates.
create index execution_kill_switches_active_lookup_idx on public.execution_kill_switches (scope, target) where enabled = true;
create index execution_kill_switches_created_at_idx on public.execution_kill_switches (created_at desc);

comment on table public.execution_kill_switches is
  'Milestone 5.5: configurable execution kill switches (GLOBAL/PROVIDER/JURISDICTION/MARKET/USER/COHORT). Rows are soft-disabled, never deleted, to preserve history. See docs/architecture/execution-operational-safety.md.';
comment on column public.execution_kill_switches.target is
  'Meaning depends on scope; never a foreign key. Null only for GLOBAL.';

alter table public.execution_kill_switches enable row level security;
grant select, insert, update on public.execution_kill_switches to service_role;

-- ---------------------------------------------------------------------------
-- Rollout cohorts
-- ---------------------------------------------------------------------------
create table public.execution_cohorts (
  id             uuid primary key default gen_random_uuid(),
  key            text not null unique check (length(key) > 0),
  name           text not null check (length(name) > 0),
  enabled        boolean not null default true,

  -- ALLOWLIST: membership is explicit rows in execution_cohort_members.
  -- PERCENTAGE: membership is deterministically derived from
  -- (rollout_seed, user_id, percentage) — see lib/execution/cohorts.ts.
  -- Percentage rollout is only added because it can be implemented
  -- deterministically (STEP 9) — never randomized per request.
  mode           text not null check (mode in ('ALLOWLIST', 'PERCENTAGE')),
  percentage     integer check (percentage is null or (percentage >= 0 and percentage <= 100)),
  rollout_seed   text,

  provider_scope     text,
  jurisdiction_scope text,

  starts_at      timestamptz,
  ends_at        timestamptz,

  created_by     uuid not null references public.user_profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint execution_cohorts_percentage_mode check (
    (mode = 'PERCENTAGE' and percentage is not null and rollout_seed is not null)
    or
    (mode = 'ALLOWLIST' and percentage is null)
  ),
  constraint execution_cohorts_window check (starts_at is null or ends_at is null or starts_at < ends_at)
);

create trigger execution_cohorts_set_updated_at
before update on public.execution_cohorts
for each row execute function public.set_updated_at();

comment on table public.execution_cohorts is
  'Milestone 5.5: provider-neutral, configuration-driven rollout cohorts. Percentage assignment is deterministic (rollout_seed + user_id), never randomized per request. See docs/architecture/execution-operational-safety.md.';

alter table public.execution_cohorts enable row level security;
grant select, insert, update on public.execution_cohorts to service_role;

create table public.execution_cohort_members (
  cohort_id  uuid not null references public.execution_cohorts (id) on delete cascade,
  user_id    uuid not null references public.user_profiles (id) on delete cascade,
  added_by   uuid not null references public.user_profiles (id),
  added_at   timestamptz not null default now(),
  primary key (cohort_id, user_id)
);

comment on table public.execution_cohort_members is
  'Milestone 5.5: explicit ALLOWLIST membership for an execution_cohorts row. Irrelevant for PERCENTAGE-mode cohorts.';

alter table public.execution_cohort_members enable row level security;
grant select, insert, delete on public.execution_cohort_members to service_role;

-- ---------------------------------------------------------------------------
-- Execution limits
-- ---------------------------------------------------------------------------
create table public.execution_limits (
  id              uuid primary key default gen_random_uuid(),

  scope           text not null check (scope in ('GLOBAL', 'USER', 'COHORT', 'JURISDICTION', 'PROVIDER')),
  target          text,

  -- The smallest limit-type set that supports Milestone 6 without forcing a
  -- redesign (STEP 12's own explicit instruction not to implement every
  -- conceivable limit). ROLLING_AMOUNT_CENTS uses window_seconds; the
  -- others are per-order or calendar-day.
  limit_type      text not null check (limit_type in ('PER_ORDER_AMOUNT_CENTS', 'DAILY_AMOUNT_CENTS', 'ROLLING_AMOUNT_CENTS', 'DAILY_ORDER_COUNT')),
  threshold_value bigint not null check (threshold_value > 0),
  window_seconds  integer check (window_seconds is null or window_seconds > 0),

  enabled         boolean not null default true,

  created_by      uuid not null references public.user_profiles (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint execution_limits_target_matches_scope check (
    (scope = 'GLOBAL' and target is null) or (scope != 'GLOBAL' and target is not null)
  ),
  constraint execution_limits_rolling_needs_window check (
    (limit_type = 'ROLLING_AMOUNT_CENTS' and window_seconds is not null)
    or
    (limit_type != 'ROLLING_AMOUNT_CENTS' and window_seconds is null)
  )
);

create trigger execution_limits_set_updated_at
before update on public.execution_limits
for each row execute function public.set_updated_at();

create index execution_limits_active_lookup_idx on public.execution_limits (scope, target) where enabled = true;

comment on table public.execution_limits is
  'Milestone 5.5: configurable, provider-neutral execution limits (no numeric value is hard-coded anywhere in application code). See docs/architecture/execution-operational-safety.md.';

alter table public.execution_limits enable row level security;
grant select, insert, update on public.execution_limits to service_role;
