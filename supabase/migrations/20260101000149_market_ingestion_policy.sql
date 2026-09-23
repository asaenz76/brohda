-- Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md, Sports Market Ingestion):
-- configurable ingestion-time policy. Lands on `platform_settings` because
-- this is the same configuration domain the existing `prediction_*`
-- columns already own (20260101000142/143/145/146/147) — "how much source
-- evidence is required before Brohda acts on a price" is the same question
-- ingestion-time bookmaker sufficiency is asking, just one step earlier in
-- the pipeline. This is NOT "put everything in platform_settings": sport/
-- league/template eligibility is deliberately NOT added here (see the R2
-- completion report — there is currently exactly one supported sport/
-- provider/competition, so an "enabled sports" config would have exactly
-- one possible value and nothing to select between; adding it now would be
-- speculative, not evidence-based).
alter table public.platform_settings
  add column market_ingestion_enabled boolean not null default false,
  add column market_ingestion_min_bookmaker_count integer not null default 2 check (market_ingestion_min_bookmaker_count >= 1);

comment on column public.platform_settings.market_ingestion_enabled is
  'Master switch for the R2 sports Market ingestion job (lib/prediction-markets/ingestion/nfl.ts). Defaults to false — an operator must explicitly enable it, matching the paid_pools_enabled/free_pools_enabled precedent for a new, previously-unproven pipeline.';
comment on column public.platform_settings.market_ingestion_min_bookmaker_count is
  'Minimum number of bookmakers that must independently quote a proposition before ingestion will create/update a canonical Market from it. Below this count, ingestion skips the proposition entirely rather than acting on thin evidence — mirrors the (currently hard-coded, legacy-pool-scoped) MIN_BOOKS_FOR_ESTIMATE precedent in lib/pools/templates/nfl-odds.ts, now made a first-class configurable value for the Prediction domain''s own ingestion path.';
