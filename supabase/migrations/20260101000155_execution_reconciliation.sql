-- Milestone 5.5. Provider-neutral reconciliation framework, exercised only
-- against a simulated/authoritative-test provider state source
-- (lib/execution/reconciliation/simulated-provider-adapter.ts) — no real
-- provider mutation API is ever called by this table's writers.
--
-- Rows are never overwritten or deleted: a repeated reconciliation of the
-- same order_intent either finds no material change (and writes nothing
-- new — see lib/execution/reconciliation/engine.ts's idempotency logic) or
-- inserts a NEW row referencing the prior one via previous_record_id,
-- preserving every previous mismatch as durable evidence rather than
-- silently overwriting it (STEP 24).
create table public.execution_reconciliation_records (
  id                  uuid primary key default gen_random_uuid(),

  -- Soft reference, same convention as execution_quotes.market_id — never a
  -- foreign key, since order_intents itself already snapshots everything
  -- this needs rather than depending on that row's own lifecycle.
  order_intent_id     uuid not null,

  -- Optional grouping for a manually-triggered batch reconciliation run —
  -- deliberately not a separate "reconciliation_runs" table (no scheduler
  -- exists or is required in Milestone 5.5, per STEP 25).
  batch_id            uuid,

  correlation_id      uuid,

  -- Brohda's own believed state going into this reconciliation attempt,
  -- and the authoritative (simulated-provider) state it was compared
  -- against. Brohda is never assumed authoritative — see STEP 21.
  expected_state      jsonb not null,
  authoritative_state jsonb not null,

  result              text not null check (result in ('IN_SYNC', 'UPDATED', 'PENDING', 'MISMATCH', 'MANUAL_REVIEW_REQUIRED')),
  mismatch_details    jsonb,

  previous_record_id  uuid references public.execution_reconciliation_records (id),

  created_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         uuid references public.user_profiles (id),
  resolution_note     text,

  constraint execution_reconciliation_records_mismatch_has_details check (
    (result in ('MISMATCH', 'MANUAL_REVIEW_REQUIRED') and mismatch_details is not null)
    or
    (result not in ('MISMATCH', 'MANUAL_REVIEW_REQUIRED'))
  ),
  constraint execution_reconciliation_records_resolution_consistency check (
    (resolved_at is null and resolved_by is null)
    or
    (resolved_at is not null and resolved_by is not null)
  )
);

create index execution_reconciliation_records_order_intent_id_idx on public.execution_reconciliation_records (order_intent_id, created_at desc);
create index execution_reconciliation_records_result_idx on public.execution_reconciliation_records (result) where result in ('MISMATCH', 'MANUAL_REVIEW_REQUIRED');
create index execution_reconciliation_records_batch_id_idx on public.execution_reconciliation_records (batch_id) where batch_id is not null;

comment on table public.execution_reconciliation_records is
  'Milestone 5.5: reconciliation history comparing Brohda''s expected OrderIntent state against a simulated authoritative provider-state source. Never overwritten — a changed result inserts a new row chained via previous_record_id. See docs/architecture/execution-operational-safety.md.';
comment on column public.execution_reconciliation_records.order_intent_id is
  'References public.order_intents(id) informally. Deliberately not a foreign key.';

alter table public.execution_reconciliation_records enable row level security;
-- Update is granted (unlike execution_audit_events) solely to allow a
-- MANUAL_REVIEW_REQUIRED row's resolved_at/resolved_by/resolution_note to
-- be filled in later — the substantive reconciliation fields
-- (expected_state/authoritative_state/result/mismatch_details) are never
-- updated by application code once a row is written; a changed comparison
-- always produces a new row instead.
grant select, insert, update on public.execution_reconciliation_records to service_role;
