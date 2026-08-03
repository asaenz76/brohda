-- Odds-driven question recommendations: a per-fixture, short-TTL odds
-- cache (read-through, refreshed on demand — see lib/actions/odds.ts) and
-- an immutable per-pool snapshot of whatever produced the recommendation
-- the admin actually published. recommendation_evidence is explicitly NOT
-- settlement evidence (pool_grading_evidence, untouched by this
-- migration) — it's informational metadata about the recommendation
-- shown at creation time, never read by grading.

create table public.fixture_odds_cache (
  external_fixture_id text primary key,
  normalized_markets   jsonb not null,
  fetched_at           timestamptz not null default now()
);

alter table public.fixture_odds_cache enable row level security;

-- Internal cache only — nothing in the client ever reads this table
-- directly, only server actions via the admin client (see the RLS-grant
-- convention already established for provider_request_log above).
grant select, insert, update on public.fixture_odds_cache to service_role;

alter table public.pools add column recommendation_evidence jsonb;

-- Extends the existing fee-immutability trigger (originally scoped to
-- question/pool_type/title/template_id/template_config) to also freeze
-- recommendation_evidence after the first entry — "before publication,
-- recommendations may change; after publication, nothing changes,"
-- including which market/consensus/probability the admin was shown.
create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.question <> old.question
      or new.pool_type <> old.pool_type
      or coalesce(new.title, '') <> coalesce(old.title, '')
      or coalesce(new.template_id, '') <> coalesce(old.template_id, '')
      or coalesce(new.template_config, '{}'::jsonb) <> coalesce(old.template_config, '{}'::jsonb)
      or coalesce(new.recommendation_evidence, '{}'::jsonb) <> coalesce(old.recommendation_evidence, '{}'::jsonb)
    then
      raise exception 'pool fields are frozen after the first entry';
    end if;

    if new.locks_at > old.locks_at then
      raise exception 'lock time may only move earlier after the first entry';
    end if;
  end if;

  return new;
end;
$$;
