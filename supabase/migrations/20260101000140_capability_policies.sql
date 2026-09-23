-- Milestone 2 final standing-rule remediation: the authorization POLICY for
-- discovery taxonomy management.
--
-- The previous remediation pass centralized the check
-- (`requireDiscoveryTaxonomyManager()`, lib/prediction-markets/discovery/
-- authorization.ts) but left the answer — "super admin only" — written in
-- application source. Under the standing rule ("hard-code invariants,
-- configure policy") that is still a hard-coded mutable policy: WHICH
-- administrative role may manage discovery taxonomy is exactly the kind of
-- decision a founder revisits, and revisiting it must not require editing
-- and deploying code.
--
-- Shape follows `discovery_sort_policy` (20260101000139) exactly, including
-- its own explicit split:
--   * the CAPABILITY KEYS are a fixed, code-defined set (this enum) — a new
--     capability is a genuine application capability that some code must
--     learn to enforce, exactly like a new sort primitive;
--   * WHICH ROLES SATISFY a capability is data (`allowed_roles`).
-- That is the whole configurable surface. No permission grammar, no rules
-- engine, no generic RBAC: one row per capability, one list of roles.
--
-- No SECURITY DEFINER function is introduced, matching this project's
-- documented history of two EXECUTE-grant-drift incidents and the Gate 1A
-- table-privilege remediation. The table is service-role-only and is read
-- server-side through lib/auth/capabilities.ts, like every other Milestone 2
-- config table.

create type public.app_capability as enum ('discovery_taxonomy_management');

create table public.capability_policies (
  capability public.app_capability primary key,
  -- Deliberately text[], not user_role[]. The application — not Postgres —
  -- is the authoritative interpreter of this policy, and it must FAIL
  -- CLOSED on anything it does not recognize. `user_role` is a growing enum
  -- (20260101000020 added 'admin' years after 20260101000002 created the
  -- type), so a typed column would let a role this build has never heard of
  -- be stored and then silently half-honored. Storing plain text forces
  -- lib/auth/capability-policy.ts to validate every entry against the role
  -- set the running application actually knows, and to deny the whole
  -- capability if any entry fails — a malformed policy grants nothing.
  allowed_roles text[] not null,
  updated_at    timestamptz not null default now()
);

create trigger capability_policies_set_updated_at
before update on public.capability_policies
for each row execute function public.set_updated_at();

alter table public.capability_policies enable row level security;

-- Same deny-by-default posture as every other Milestone 2 config table: no
-- anon/authenticated policy at all, so ordinary users cannot read this
-- configuration, let alone write it. Reads happen server-side via the
-- service-role client; writes happen through the protected operational path
-- (scripts/set-capability-policy.ts), which needs the service-role key.
grant select, insert, update, delete on public.capability_policies to service_role;

-- Seed reproduces today's effective behavior exactly: super admin only.
-- This migration changes WHERE the policy lives, not its current value.
insert into public.capability_policies (capability, allowed_roles)
values ('discovery_taxonomy_management', array['super_admin']);
