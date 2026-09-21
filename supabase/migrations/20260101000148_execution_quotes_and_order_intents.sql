-- Prediction Network transformation, Milestone 5 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
-- Milestone 5 — Simulated Execution). Additive only. No real financial
-- exposure, no provider order, no wallet, no custody record — see
-- docs/architecture/simulated-execution.md for the full design.
--
-- Two tables, mirroring the Prediction/Market preservation pattern already
-- established in Milestone 3: `market_id` is a plain uuid soft reference on
-- both (never a foreign key), and `order_intents` snapshots its own
-- economics at confirmation time rather than depending on `execution_quotes`
-- continuing to exist.
--
-- `is_simulated boolean not null default true` on both tables is the
-- structural (not merely copy-level) marker that these are Milestone 5
-- simulation records — required so a future Milestone 6 real-execution
-- domain can never be confused with these rows even if it reuses similar
-- column shapes.

create table public.execution_quotes (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.user_profiles (id) on delete cascade,

  -- Soft reference only — see header comment. Never a foreign key.
  market_id                   uuid not null,

  selected_side               text not null check (selected_side in ('YES', 'NO')),
  requested_amount_cents      integer not null check (requested_amount_cents > 0),

  -- The provider-derived current price (0-1) for the selected side at
  -- snapshot time — independent read, same convention as Prediction's own
  -- probability snapshot.
  current_price               numeric not null check (current_price >= 0 and current_price <= 1),
  -- The depth-weighted average execution price the simulated order-book
  -- walk actually produced for requested_amount_cents. Never equal to
  -- current_price by assumption — see lib/execution/quote-math.ts.
  effective_price             numeric not null check (effective_price >= 0 and effective_price <= 1),
  estimated_units             numeric not null check (estimated_units >= 0),
  estimated_gross_return_cents integer not null check (estimated_gross_return_cents >= 0),

  provider_fee_estimate_cents integer not null check (provider_fee_estimate_cents >= 0),
  brohda_fee_estimate_cents   integer not null check (brohda_fee_estimate_cents >= 0),
  total_fee_estimate_cents    integer not null check (total_fee_estimate_cents >= 0),
  estimated_slippage_bps      integer not null check (estimated_slippage_bps >= 0),

  -- When the order-book snapshot behind this quote was actually fetched —
  -- distinct from created_at (freshness is about the DATA, not the quote
  -- row itself; see docs/architecture/simulated-execution.md §10/§12).
  provider_snapshot_at        timestamptz not null,
  expires_at                  timestamptz not null,

  is_simulated                boolean not null default true check (is_simulated = true),

  created_at                  timestamptz not null default now()
);

create index execution_quotes_user_id_created_at_idx on public.execution_quotes (user_id, created_at desc);
create index execution_quotes_market_id_idx on public.execution_quotes (market_id);

comment on table public.execution_quotes is
  'Milestone 5 simulated execution quotes — temporary, non-financial estimates. market_id is a soft reference, not a foreign key. See docs/architecture/simulated-execution.md.';
comment on column public.execution_quotes.market_id is
  'References public.markets(id) informally. Deliberately not a foreign key — see docs/architecture/simulated-execution.md.';
comment on column public.execution_quotes.is_simulated is
  'Always true in Milestone 5 — structural marker that this row represents no real financial exposure. Never real-money-execution data.';

alter table public.execution_quotes enable row level security;

create policy "select_own_execution_quotes"
on public.execution_quotes for select
to authenticated
using (user_id = auth.uid());

-- No insert/update/delete policy for authenticated — matches the
-- established convention (predictions, capability_policies): RLS
-- restricts reads, a Server Action's service-role client authorizes
-- writes, authenticated by requireUser() in the action itself.
grant select on public.execution_quotes to authenticated;
grant select, insert, update, delete on public.execution_quotes to service_role;

create table public.order_intents (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.user_profiles (id) on delete cascade,
  market_id                   uuid not null,

  -- Traceability only — diagnostics/audit, not a source of truth. This
  -- row's own snapshot columns below are authoritative for its own
  -- history, exactly like Prediction's market snapshot pattern.
  quote_id                    uuid not null,

  selected_side               text not null check (selected_side in ('YES', 'NO')),
  requested_amount_cents      integer not null check (requested_amount_cents > 0),
  quoted_effective_price      numeric not null check (quoted_effective_price >= 0 and quoted_effective_price <= 1),
  quoted_estimated_gross_return_cents integer not null check (quoted_estimated_gross_return_cents >= 0),
  quoted_total_fee_estimate_cents     integer not null check (quoted_total_fee_estimate_cents >= 0),
  quoted_slippage_bps         integer not null check (quoted_slippage_bps >= 0),
  quote_created_at            timestamptz not null,
  quote_provider_snapshot_at  timestamptz not null,

  confirmed_at                timestamptz not null default now(),

  -- Lifecycle: CONFIRMED is the transient "user confirmed, evaluating"
  -- state; every row this milestone's synchronous flow ever leaves
  -- persisted already carries a terminal result — kept as a real state
  -- (not collapsed away) so Milestone 6's async provider round-trip can
  -- reuse the same shape without a redesign.
  lifecycle_state             text not null default 'CONFIRMED' check (lifecycle_state in ('CONFIRMED', 'SIMULATED_FILLED', 'SIMULATED_REJECTED')),
  result_reason               text check (result_reason in ('MARKET_CLOSED', 'STALE_DATA', 'INSUFFICIENT_LIQUIDITY', 'SLIPPAGE_TOO_HIGH', 'NOT_ELIGIBLE')),
  resolved_at                 timestamptz,

  idempotency_key             text not null,

  is_simulated                boolean not null default true check (is_simulated = true),

  created_at                  timestamptz not null default now(),

  constraint order_intents_result_requires_terminal_state
    check (
      (lifecycle_state = 'CONFIRMED' and result_reason is null and resolved_at is null)
      or
      (lifecycle_state in ('SIMULATED_FILLED', 'SIMULATED_REJECTED') and resolved_at is not null)
    ),
  -- A rejection always has a reason; a fill never carries a rejection reason.
  constraint order_intents_reason_matches_state
    check (
      (lifecycle_state = 'SIMULATED_REJECTED' and result_reason is not null)
      or
      (lifecycle_state != 'SIMULATED_REJECTED' and result_reason is null)
    )
);

create unique index order_intents_idempotency_key_key on public.order_intents (idempotency_key);
create index order_intents_user_id_created_at_idx on public.order_intents (user_id, created_at desc);
create index order_intents_market_id_idx on public.order_intents (market_id);

comment on table public.order_intents is
  'Milestone 5 Brohda-owned record of a user confirming simulated execution. NOT a provider Order — no real order was placed. See docs/architecture/simulated-execution.md.';
comment on column public.order_intents.market_id is
  'References public.markets(id) informally. Deliberately not a foreign key.';
comment on column public.order_intents.quote_id is
  'References public.execution_quotes(id) informally, for traceability only — this row''s own quoted_* snapshot columns are the source of truth, not a join back to execution_quotes.';
comment on column public.order_intents.is_simulated is
  'Always true in Milestone 5 — structural marker, not merely a UI label. No provider order, fill, or financial exposure exists for this row.';

alter table public.order_intents enable row level security;

create policy "select_own_order_intents"
on public.order_intents for select
to authenticated
using (user_id = auth.uid());

grant select on public.order_intents to authenticated;
grant select, insert, update, delete on public.order_intents to service_role;
