-- Milestone 2 hard-coding remediation, Finding 1: discovery ordering was
-- centralized in code, but the PRIORITY SEQUENCE and DIRECTION of sort
-- criteria are mutable product policy (a founder could reasonably want
-- close-time-first instead of freshness-first later), not a domain
-- invariant. The supported sort PRIMITIVES themselves (FRESHNESS,
-- CLOSE_TIME, LIQUIDITY) remain a fixed, hard-coded set — per the
-- remediation's own instruction, "the supported sorting primitives
-- themselves may remain hard-coded domain/application capabilities." What
-- moves to data is which ones are active, in what order, and which
-- direction — never an arbitrary expression, SQL snippet, or rules engine.

create type public.discovery_sort_criterion as enum ('FRESHNESS', 'CLOSE_TIME', 'LIQUIDITY');
create type public.discovery_sort_direction as enum ('ASC', 'DESC');

create table public.discovery_sort_policy (
  criterion    public.discovery_sort_criterion primary key,
  -- Lower priority number = applied first (the primary sort key). Plain
  -- integer, same "simple explicit order number" convention already used
  -- for discovery_categories.display_order.
  priority     integer not null,
  direction    public.discovery_sort_direction not null,
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now()
);

create trigger discovery_sort_policy_set_updated_at
before update on public.discovery_sort_policy
for each row execute function public.set_updated_at();

alter table public.discovery_sort_policy enable row level security;

-- Same deny-by-default posture as every other Milestone 2 config table —
-- no anon/authenticated policy; consumer reads happen server-side via the
-- service-role client, never a direct client query.
grant select, insert, update, delete on public.discovery_sort_policy to service_role;

-- Seed rows reproduce Milestone 2's original code-constant behavior exactly
-- (freshness tier first, then soonest close, then liquidity as a
-- tiebreaker) — this migration changes WHERE the policy lives, not its
-- current effective value.
insert into public.discovery_sort_policy (criterion, priority, direction, enabled) values
  ('FRESHNESS', 0, 'ASC', true),
  ('CLOSE_TIME', 1, 'ASC', true),
  ('LIQUIDITY', 2, 'DESC', true);
