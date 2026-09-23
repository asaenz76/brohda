-- Prediction Network transformation, Milestone 2 (docs/PRODUCT_TRANSFORMATION_ROADMAP.md
-- Milestone 2 — Prediction Market Discovery Experience). Additive only — no
-- legacy pool table, and no Milestone 1 `markets` column, is touched.
--
-- This is the configurable discovery-taxonomy data model. Per the
-- milestone's own core principle ("hard-code invariants, configure
-- policy"), category taxonomy and provider-tag mapping are genuinely
-- mutable product policy — normal operating changes (rename a category,
-- reorder it, disable it, add a new provider-tag mapping) must never
-- require a source-code change or deployment, so they live here as data,
-- not as a TypeScript enum.
--
-- No SECURITY DEFINER function is introduced (matching Milestone 1's own
-- precedent and this project's documented history of two prior EXECUTE-
-- grant-drift incidents plus the Gate 1A table-privilege remediation) —
-- both tables are service-role-only, mutated through ordinary admin Server
-- Actions using the existing service-role admin client, exactly like
-- `markets` itself.

create table public.discovery_categories (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  display_name   text not null,
  description    text,
  -- Plain explicit order number, not a linked-list/fractional-index scheme
  -- — an admin reordering a handful of categories is exactly the case this
  -- milestone's own guidance says a "simple explicit order number is
  -- acceptable" for.
  display_order  integer not null default 0,
  enabled        boolean not null default true,
  -- A short, free-form key (e.g. an icon-set name) — never the only way a
  -- category is represented in the UI (accessibility requirement: text
  -- label is always present alongside).
  icon_key       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_discovery_categories_enabled_order
  on public.discovery_categories (enabled, display_order);

create trigger discovery_categories_set_updated_at
before update on public.discovery_categories
for each row execute function public.set_updated_at();

alter table public.discovery_categories enable row level security;

-- No policy for anon/authenticated — deliberately deny-by-default, matching
-- Milestone 1's own `markets` posture: every consumer-facing discovery read
-- goes through a server-side Server Component using the service-role
-- client (Brohda UI -> Brohda server/domain read layer -> normalized
-- Brohda database), never a direct client-side query against this table.
-- This alone is what makes "ordinary players cannot modify categories"
-- trivially true — they cannot even read the raw config table directly.
grant select, insert, update, delete on public.discovery_categories to service_role;

-- Maps a provider's own tag/category identifier onto exactly one Brohda
-- discovery category. Deliberately simple — one enabled mapping per
-- (provider, provider_tag) pair, no priority/weighting, no ML/rules engine.
-- An unmapped provider tag simply has no row here, which the application
-- layer treats as "uncategorized," never a crash (lib/prediction-markets/
-- discovery/category-mapping.ts).
create table public.discovery_category_provider_mappings (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references public.discovery_categories(id) on delete cascade,
  provider       text not null,
  -- The raw tag/category key as captured by Milestone 1's ingestion
  -- (provider_metadata._categoryTagsExtracted) — intentionally provider-
  -- specific on this side of the mapping table only; nothing downstream of
  -- this table ever sees a provider_tag value.
  provider_tag   text not null,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint discovery_mapping_provider_tag_unique unique (provider, provider_tag)
);

create index idx_discovery_mappings_category on public.discovery_category_provider_mappings (category_id);
create index idx_discovery_mappings_lookup on public.discovery_category_provider_mappings (provider, provider_tag) where enabled = true;

create trigger discovery_mappings_set_updated_at
before update on public.discovery_category_provider_mappings
for each row execute function public.set_updated_at();

alter table public.discovery_category_provider_mappings enable row level security;

grant select, insert, update, delete on public.discovery_category_provider_mappings to service_role;
