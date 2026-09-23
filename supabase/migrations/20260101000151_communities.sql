-- Milestone R4 (docs/BROHDA_2_0_MILESTONE_MAP.md, Community + Distribution).
-- Additive only.
--
-- Community identity (§6-7): references canonical internal sports identity
-- (teams.id / leagues.id) rather than duplicating mutable display text —
-- both tables already exist with real UUID identity and
-- (provider, external_id) uniqueness (20260101000078_teams_and_leagues.sql),
-- populated automatically alongside every fixture sync
-- (lib/sports-data/persist.ts's toTeamRows/toLeagueRow). No canonical
-- `sports` relational entity exists anywhere in this codebase — `sport` is
-- a plain text column on `fixtures` (verified: the only two values ever
-- seen are 'football'/api_football, now retired, and 'american_football'/
-- api_nfl, the current sport). Per this milestone's own instruction ("do
-- not invent a huge taxonomy rewrite... implement the smallest safe
-- representation and report the limitation"), SPORT-type Communities use a
-- plain `sport_key` text identity instead of a foreign key — a real,
-- reported limitation, not a taxonomy this migration invents.
create type public.community_type as enum ('TEAM', 'LEAGUE', 'SPORT');

create table public.communities (
  id           uuid primary key default gen_random_uuid(),
  type         public.community_type not null,
  team_id      uuid references public.teams (id),
  league_id    uuid references public.leagues (id),
  sport_key    text,
  slug         text not null unique,
  -- Presentation exception, narrowly scoped: TEAM/LEAGUE Communities NEVER
  -- store a display name here (§6: "avoid copying team name, logo, league
  -- metadata onto Community") — their presentation is always derived live
  -- by joining team_id/league_id back to teams/leagues. SPORT is the one
  -- case with no canonical entity to join, so it alone needs a stored
  -- name; the shape constraint below enforces this split structurally.
  display_name text,
  -- Minimal lifecycle (§33): Brohda may need to stop distributing into a
  -- Community without erasing its historical distribution rows. No
  -- broader state machine than this one boolean is introduced.
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint communities_type_shape check (
    (type = 'TEAM' and team_id is not null and league_id is null and sport_key is null and display_name is null)
    or (type = 'LEAGUE' and league_id is not null and team_id is null and sport_key is null and display_name is null)
    or (type = 'SPORT' and sport_key is not null and team_id is null and league_id is null and display_name is not null)
  )
);

-- One canonical Community per (type, sports subject) — same coalesce-nulls
-- pattern as R1's markets_sports_proposition_unique, for the same reason:
-- a plain unique index treats NULL <> NULL, which would silently allow
-- duplicate SPORT/LEAGUE/TEAM rows without this normalization. A renamed
-- team/league (§32) never creates a new Community: team_id/league_id are
-- immutable internal identity, unaffected by teams.name changing.
create unique index communities_subject_unique on public.communities (
  type, coalesce(team_id::text, ''), coalesce(league_id::text, ''), coalesce(sport_key, '')
);

create index idx_communities_team_id on public.communities (team_id) where team_id is not null;
create index idx_communities_league_id on public.communities (league_id) where league_id is not null;

create trigger communities_set_updated_at
before update on public.communities
for each row execute function public.set_updated_at();

-- Defense in depth, mirroring R1/R3's identity-immutability triggers: no
-- application code ever changes which sports subject a Community
-- represents once created.
create or replace function public.forbid_community_subject_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.type is distinct from old.type
    or new.team_id is distinct from old.team_id
    or new.league_id is distinct from old.league_id
    or new.sport_key is distinct from old.sport_key
  then
    raise exception 'communities.%''s sports-subject identity (type/team_id/league_id/sport_key) is immutable once set', old.id;
  end if;
  return new;
end;
$$;

create trigger communities_forbid_subject_mutation
before update on public.communities
for each row execute function public.forbid_community_subject_mutation();

alter table public.communities enable row level security;

-- Communities are public, browsable objects (like teams/leagues
-- themselves) — readable by any authenticated member regardless of
-- `active`, matching teams/leagues' own "members_can_read_*" precedent.
-- `active` is an application-level filter (feed/distribution eligibility),
-- not an RLS concern, the same way markets.status is.
create policy "members_can_read_communities"
on public.communities for select
to authenticated
using (true);

grant select on public.communities to authenticated;
grant select, insert, update, delete on public.communities to service_role;

-- Post <-> Community distribution (§4-5, §13): a plain many-to-many join.
-- `post_id`/`community_id` are real FKs (both posts and communities are
-- durable, never deleted — matching R1/R3's "fixtures/markets/posts are
-- never deleted" reasoning for a real, non-cascading FK). The composite
-- primary key IS the uniqueness enforcement (§13/§17): the same Post can
-- never distribute into the same Community twice. Deliberately no surrogate
-- id — this row means exactly one fact ("this Post is relevant to this
-- Community") and never needs its own identity beyond that pair.
create table public.post_communities (
  post_id      uuid not null references public.posts (id),
  community_id uuid not null references public.communities (id),
  created_at   timestamptz not null default now(),

  primary key (post_id, community_id)
);

create index idx_post_communities_community_id on public.post_communities (community_id, created_at desc);

alter table public.post_communities enable row level security;

-- No policy for `authenticated`/`anon` at all — matching `markets`' own
-- established convention for a table with no direct consumer-facing query
-- shape of its own. Every read (Community feed, "which Communities is this
-- Post in") goes through lib/communities/*.ts's own repository functions
-- via the service-role admin client; every write (distribution) is
-- platform-only.
grant select, insert, update, delete on public.post_communities to service_role;

-- Community following (§19-20): pure existence-based follow, distinct from
-- `follows` (user-to-user) and from `team_follows`/`league_follows`
-- (private notification preferences, R0.5's own finding — NOT reinterpreted
-- here). Own-row read only; no direct write grant to `authenticated` at
-- all — follow/unfollow go through lib/actions/communities.ts's
-- service-role-mediated Server Actions (matching predictions/pool_likes'
-- "no authenticated write policy" convention), not team_follows' own
-- direct-UPDATE convention, because this is a create/delete-the-row
-- operation, not a toggle-a-field-on-an-ambient-row operation.
create table public.community_follows (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.user_profiles (id) on delete cascade,
  community_id uuid not null references public.communities (id) on delete cascade,
  created_at   timestamptz not null default now(),

  constraint unique_community_follow unique (user_id, community_id)
);

create index idx_community_follows_user_id on public.community_follows (user_id);
create index idx_community_follows_community_id on public.community_follows (community_id);

alter table public.community_follows enable row level security;

create policy "select_own_community_follows"
on public.community_follows for select
to authenticated
using (user_id = auth.uid());

grant select on public.community_follows to authenticated;
grant select, insert, update, delete on public.community_follows to service_role;

-- Milestone R4 configurable policy — same platform_settings domain
-- R2/R3's own ingestion/publication policy columns already established.
alter table public.platform_settings
  add column community_distribution_enabled boolean not null default false,
  add column community_team_distribution_enabled boolean not null default true,
  add column community_league_distribution_enabled boolean not null default true,
  add column community_sport_distribution_enabled boolean not null default true;

comment on column public.platform_settings.community_distribution_enabled is
  'Master switch for the automatic Post-distribution job (lib/communities/distribution.ts). Defaults to false, matching post_publication_enabled/market_ingestion_enabled''s precedent for a new, previously-unproven pipeline.';
comment on column public.platform_settings.community_team_distribution_enabled is
  'Whether automatic distribution creates/targets a TEAM Community for a Post''s home/away teams.';
comment on column public.platform_settings.community_league_distribution_enabled is
  'Whether automatic distribution creates/targets a LEAGUE Community for a Post''s competition.';
comment on column public.platform_settings.community_sport_distribution_enabled is
  'Whether automatic distribution creates/targets a SPORT Community for a Post''s sport.';
