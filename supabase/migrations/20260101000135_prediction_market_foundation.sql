-- Prediction Network transformation, Milestone 1 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md,
-- Milestone 1 — Read-Only Market Foundation): the provider-neutral, read-only
-- Market domain. Additive only — no legacy pool/entry/settlement table is
-- touched, and nothing here references them by foreign key (matching this
-- codebase's own existing precedent on wallet_transactions/audit_logs: a
-- new, independent domain never gets wired into the legacy engine's tables
-- just because both happen to describe "something a user can predict on").
--
-- No SECURITY DEFINER function is introduced by this migration. Given this
-- project's own history of two prior EXECUTE-grant-drift incidents
-- (20260101000107, 20260101000134), the simplest and safest choice for a
-- brand-new, non-financial table is to skip RPCs entirely: every write goes
-- through the existing service-role admin client
-- (lib/supabase/admin.ts's createAdminClient()) via plain table access,
-- which this migration grants explicitly and narrowly.

create type public.prediction_market_status as enum (
  'ACTIVE',
  'INACTIVE',
  'CLOSED',
  'ARCHIVED'
);

-- Provider-neutral catalog of external prediction markets. Deliberately
-- named `markets`, not `polymarket_markets` — nothing above the adapter
-- layer (lib/prediction-markets/providers/polymarket/*) is allowed to
-- assume Polymarket is the only provider that will ever populate this
-- table (docs/PRODUCT_TRANSFORMATION_ROADMAP.md §2).
create table public.markets (
  id                    uuid primary key default gen_random_uuid(),

  -- Provider identity. `provider` is a plain string, not an enum — mirrors
  -- fixtures.provider's own convention (lib/sports-data/provider-names.ts),
  -- since a new provider should never require a schema migration just to
  -- register.
  provider              text not null,
  provider_market_id    text not null,
  -- Best-effort — populated only when the ingestion path that produced this
  -- row actually observed an event grouping for it. Not treated as a
  -- guaranteed-present field anywhere in application code.
  provider_event_id     text,

  question              text not null,
  description           text,

  status                public.prediction_market_status not null,

  -- Normalized YES/NO prices, independently read from the provider's own
  -- per-outcome price array — never derived as `no = 1 - yes` (see
  -- docs/architecture/prediction-market-provider.md's price-semantics
  -- section). Null means "not available from the provider at ingestion
  -- time", never a substituted zero.
  yes_price             numeric,
  no_price              numeric,
  -- Which raw provider outcome label was matched to yes/no (e.g.
  -- {"yes":"Yes","no":"No"}) — an auditable record of the mapping decision,
  -- not a guess a future reader has to reverse-engineer.
  price_outcome_labels  jsonb,

  volume_24hr           numeric,
  liquidity             numeric,

  -- Resolution tracking. Deliberately conservative: Milestone 1 does not
  -- claim to know how to authoritatively determine a resolved outcome (see
  -- docs/architecture/prediction-market-provider.md's known limitations) —
  -- resolution_status/resolved_by are raw, provider-specific, diagnostic
  -- pass-through only, and resolved_outcome is never populated by this
  -- milestone's ingestion code (always null), existing only so a later,
  -- properly-researched milestone doesn't need a schema change to use it.
  resolution_status     text,
  resolved_by           text,
  resolved_outcome      text,

  opens_at              timestamptz,
  closes_at             timestamptz,
  closed_at             timestamptz,

  -- Brohda's own ingestion timestamp — the actual price/liquidity/status
  -- freshness signal a future consumer surface (Milestone 2) reasons about,
  -- since no confirmed provider "last updated" field was found in official
  -- Polymarket documentation at the time this was written (see the
  -- architecture doc's research notes).
  last_synced_at        timestamptz not null,

  -- Which eligibility rule caused this market to be ingested (e.g.
  -- "explicit_market_id:0x1234", "category_tag:politics") — lets a future
  -- reader (or the inspection script) answer "why is this row here" without
  -- re-deriving it from the current criteria config, which may have already
  -- changed by the time anyone asks.
  ingestion_source      text not null,

  -- Raw, diagnostic-only provider payload (booleans like restricted/
  -- negRisk/acceptingOrders, the raw outcomes/outcomePrices arrays,
  -- clobTokenIds, best bid/ask/last-trade if present, etc.). Explicitly not
  -- part of the normalized contract any other Brohda code should read from
  -- — see docs/architecture/prediction-market-provider.md's provider
  -- boundary section.
  provider_metadata     jsonb,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint markets_provider_market_unique unique (provider, provider_market_id)
);

create index idx_markets_status on public.markets (status);
create index idx_markets_last_synced_at on public.markets (last_synced_at);
create index idx_markets_closes_at on public.markets (closes_at);
create index idx_markets_provider_event_id on public.markets (provider_event_id) where provider_event_id is not null;

create trigger markets_set_updated_at
before update on public.markets
for each row execute function public.set_updated_at();

alter table public.markets enable row level security;

-- No policy for `anon`/`authenticated` at all — deliberately deny-by-default
-- for direct client access, matching this codebase's own existing pattern
-- for tables with no consumer-facing need yet (background_jobs,
-- cron_job_locks per the architectural audit's §8). Milestone 1 has no
-- consumer surface (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 1's
-- explicit out-of-scope list) — a read policy for `authenticated` is a
-- Milestone 2 decision, not this one's to make.
grant select, insert, update, delete on public.markets to service_role;
