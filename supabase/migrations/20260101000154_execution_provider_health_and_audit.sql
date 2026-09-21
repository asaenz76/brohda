-- Milestone 5.5. Provider-neutral provider-health/circuit-breaker state,
-- and the durable execution audit-event stream. Additive only.

-- ---------------------------------------------------------------------------
-- Provider health / circuit breaker
-- ---------------------------------------------------------------------------
-- One row per provider (a small, singleton-per-provider table, not a growing
-- log) — this row IS the circuit breaker's persisted state, and
-- `circuit_state` plus `manually_disabled` together derive the
-- HEALTHY/DEGRADED/UNAVAILABLE/MANUALLY_DISABLED status a consumer of this
-- table sees (lib/execution/provider-health.ts). Combining "breaker state"
-- and "manual override" into one row avoids a config-junk-drawer split
-- across two tables for what is really one operational concept per
-- provider.
create table public.execution_provider_health (
  provider              text primary key,

  circuit_state         text not null default 'CLOSED' check (circuit_state in ('CLOSED', 'OPEN', 'HALF_OPEN')),
  consecutive_failures  integer not null default 0 check (consecutive_failures >= 0),
  last_failure_at       timestamptz,
  last_success_at       timestamptz,
  opened_at             timestamptz,
  half_open_probe_at    timestamptz,

  manually_disabled     boolean not null default false,
  manual_reason         text,
  manual_set_by         uuid references public.user_profiles (id),
  manual_set_at         timestamptz,

  updated_at            timestamptz not null default now(),

  constraint execution_provider_health_manual_consistency check (
    (manually_disabled = false and manual_reason is null and manual_set_by is null and manual_set_at is null)
    or
    (manually_disabled = true and manual_reason is not null and manual_set_by is not null and manual_set_at is not null)
  )
);

create trigger execution_provider_health_set_updated_at
before update on public.execution_provider_health
for each row execute function public.set_updated_at();

comment on table public.execution_provider_health is
  'Milestone 5.5: provider-neutral circuit-breaker state + manual override, one row per provider. Status (HEALTHY/DEGRADED/UNAVAILABLE/MANUALLY_DISABLED) is derived, not stored — see lib/execution/provider-health.ts.';

alter table public.execution_provider_health enable row level security;
grant select, insert, update on public.execution_provider_health to service_role;

-- ---------------------------------------------------------------------------
-- Execution audit events
-- ---------------------------------------------------------------------------
-- The durable, provider-neutral execution event stream (STEP 17/18) — a
-- dedicated table because the generic audit_logs table (lib/audit/log.ts)
-- is shaped for admin before/after mutation records, not for a
-- correlation-threaded business-event stream a future reconciliation or
-- incident investigation needs to query by correlation_id, market, quote,
-- or order intent. Structurally append-only: service_role is granted
-- select+insert only, never update or delete — nothing, including server
-- code, may rewrite a past event.
create table public.execution_audit_events (
  id               uuid primary key default gen_random_uuid(),
  event_type       text not null check (length(event_type) > 0),
  occurred_at      timestamptz not null default now(),

  -- Threads one execution journey (quote -> confirmation -> simulated
  -- outcome -> reconciliation) together. Nullable because not every event
  -- (e.g. a provider-health change) belongs to one user journey.
  correlation_id   uuid,

  actor_user_id    uuid,
  market_id        text,
  quote_id         uuid,
  order_intent_id  uuid,
  provider         text,

  severity         text not null default 'INFO' check (severity in ('INFO', 'WARN', 'ERROR', 'CRITICAL')),

  -- Structured, safe metadata only. Application code (lib/execution/audit.ts)
  -- is responsible for never placing a secret, private key, Session Key,
  -- raw credential, or signature into this column — enforced by review and
  -- by the redaction guard in lib/execution/audit.ts itself, not by the
  -- database (a database-level content filter cannot know what a "secret"
  -- looks like).
  metadata         jsonb not null default '{}'::jsonb,

  created_at       timestamptz not null default now()
);

create index execution_audit_events_correlation_id_idx on public.execution_audit_events (correlation_id) where correlation_id is not null;
create index execution_audit_events_event_type_occurred_at_idx on public.execution_audit_events (event_type, occurred_at desc);
create index execution_audit_events_occurred_at_idx on public.execution_audit_events (occurred_at desc);

comment on table public.execution_audit_events is
  'Milestone 5.5: durable, append-only, provider-neutral execution event stream. Never store private keys, Session Keys, raw credentials, or signatures in metadata. See docs/architecture/execution-operational-safety.md.';
comment on column public.execution_audit_events.metadata is
  'Safe structured metadata only — never a secret-bearing value. See lib/execution/audit.ts.';

alter table public.execution_audit_events enable row level security;
-- Append-only even from service_role: select + insert only, no update, no
-- delete. This is a stronger guarantee than "ordinary application users
-- cannot mutate it" — nothing in this codebase can mutate a past event.
grant select, insert on public.execution_audit_events to service_role;
