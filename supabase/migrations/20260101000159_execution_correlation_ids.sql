-- Milestone 5.5 correlation-ID threading (STEP 19). A full execution
-- journey (quote -> confirmation -> simulated outcome -> reconciliation ->
-- audit events) must be traceable by one stable identifier, generated once
-- at quote-request time and carried forward — never a fresh, unrelated ID
-- minted at every layer. See lib/execution/correlation.ts.
--
-- Additive only. Existing local rows (test/dev data) receive a generated
-- default so the column can be NOT NULL; application code always passes an
-- explicit value going forward (lib/execution/quote-service.ts).
alter table public.execution_quotes
  add column correlation_id uuid not null default gen_random_uuid();

alter table public.order_intents
  add column correlation_id uuid not null default gen_random_uuid();

create index execution_quotes_correlation_id_idx on public.execution_quotes (correlation_id);
create index order_intents_correlation_id_idx on public.order_intents (correlation_id);

comment on column public.execution_quotes.correlation_id is
  'Milestone 5.5: generated once when the Quote is created; carried forward onto the confirming OrderIntent and every execution_audit_events row for this journey. Survives retries — a duplicate confirmation attempt reuses the same Quote and therefore the same correlation_id.';
comment on column public.order_intents.correlation_id is
  'Milestone 5.5: inherited from the parent Quote at confirmation time (execution_quotes.correlation_id), not independently generated — see lib/execution/correlation.ts.';
