-- Milestone R3 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Foundation): the
-- canonical SOCIAL representation of a Game. Additive only.
--
-- Relationship choice: a real, unique, non-cascading FK to `fixtures.id`,
-- mirroring R1's `markets.fixture_id` reasoning exactly — fixtures are
-- never deleted anywhere in this codebase, so a real FK gives genuine
-- integrity at no durability cost, and a soft reference would buy nothing.
-- `unique (fixture_id)` is the structural enforcement of "one canonical
-- Game Post" (§3/§7) — the database, not application discipline, is what
-- makes a second Post for the same Game impossible.
--
-- Existence vs. publication (§8): `published_at timestamptz` (nullable)
-- rather than a status enum. A null value means the Post exists (created,
-- e.g. by an automatic publication job that decided not to show it yet)
-- but is not publicly visible; a non-null value is the moment it became
-- visible. This deliberately mirrors predictions.graded_at's own
-- "nullable timestamp doubles as both a state flag and a historical fact"
-- pattern rather than introducing a parallel enum plus a separate
-- timestamp. No "hidden"/"archived" state was added — R3 has no
-- moderation/comment surface yet to hide from, and the task explicitly
-- warns against inventing aggressive archival behavior. A cancelled or
-- completed Game's Post simply stays published; presentation reads the
-- Game's own status for that context.
create table public.posts (
  id           uuid primary key default gen_random_uuid(),
  fixture_id   uuid not null references public.fixtures (id),
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint posts_one_per_fixture unique (fixture_id)
);

create trigger posts_set_updated_at
before update on public.posts
for each row execute function public.set_updated_at();

-- Defense in depth, mirroring R1's markets_forbid_identity_mutation
-- exactly: no code path in this application ever updates a Post's
-- fixture_id (the repository only inserts/selects/publishes — see
-- lib/posts/repository.ts), and no client role can write to this table at
-- all (below). This trigger makes "a Post's Game association cannot be
-- mutated" a database-enforced invariant rather than merely an absence of
-- application code, the same reasoning that justified R1's own trigger.
create or replace function public.forbid_post_fixture_reassignment()
returns trigger
language plpgsql
as $$
begin
  if new.fixture_id is distinct from old.fixture_id then
    raise exception 'posts.%''s fixture_id is immutable once set; a Post''s Game association can never be reassigned', old.id;
  end if;
  return new;
end;
$$;

create trigger posts_forbid_fixture_reassignment
before update on public.posts
for each row execute function public.forbid_post_fixture_reassignment();

alter table public.posts enable row level security;

-- Only published Posts are readable by ordinary members — an unpublished
-- Post is Brohda's own internal/pending state, not yet a public social
-- object. No insert/update/delete policy exists for `authenticated` at
-- all: every write goes through the service-role admin client
-- (lib/posts/repository.ts), matching this codebase's established
-- convention for `markets`/`predictions` (RLS restricts reads only; a
-- Server Action's own authorization check, not an RLS INSERT policy, is
-- what gates writes).
create policy "members_can_read_published_posts"
on public.posts for select
to authenticated
using (published_at is not null);

grant select on public.posts to authenticated;
grant select, insert, update, delete on public.posts to service_role;

-- Milestone R3 configurable policy (docs/BROHDA_2_0_MILESTONE_MAP.md's own
-- unbreakable hard-coding rule) — same platform_settings domain the R2
-- ingestion-policy columns already established for this exact class of
-- "should the platform act automatically, and under what threshold"
-- question.
alter table public.platform_settings
  add column post_publication_enabled boolean not null default false,
  add column post_publication_requires_active_market boolean not null default true,
  add column post_primary_market_template_priority text[] not null default array['MONEYLINE', 'TOTAL', 'SPREAD'];

comment on column public.platform_settings.post_publication_enabled is
  'Master switch for the automatic Post-publication job (lib/posts/publication.ts). Defaults to false, matching market_ingestion_enabled''s precedent for a new, previously-unproven pipeline.';
comment on column public.platform_settings.post_publication_requires_active_market is
  'Whether a fixture must already have at least one ACTIVE Market before its Post is auto-published. True by default: a Post with no valid Market to interact with is not yet useful to publish automatically. Manual publication (scripts/publish-posts.ts, run explicitly) is not bound by this policy.';
comment on column public.platform_settings.post_primary_market_template_priority is
  'Ordered MarketTemplate preference (lib/posts/primary-market.ts) used to pick which of a Game''s current ACTIVE Markets a Post presents as primary. Purely a presentation/query preference — never affects Market identity, grading, or Pick storage.';
