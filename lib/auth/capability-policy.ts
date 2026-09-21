/**
 * Pure capability-policy decisions — no I/O, no `server-only`, so the whole
 * allow/deny rule is unit-testable with an explicit policy value, exactly
 * like `lib/auth/guards.ts` is for session shape and
 * `classifyFreshness`/`compareDiscoveryMarkets` are for their own policies.
 * The database read lives next door in `lib/auth/capabilities.ts`.
 *
 * Milestone 2 final standing-rule remediation: a feature asks "may this user
 * use capability X," and the answer comes from configuration
 * (`capability_policies`, migration 20260101000140), never from a role
 * comparison written into the feature.
 */

/**
 * The closed set of capability keys. Hard-coded on purpose, and this is the
 * part of the model the standing rule says MAY stay in code: a capability
 * only means anything because some code enforces it, so adding one is a
 * genuine application change — the same reasoning that keeps the discovery
 * sort *primitives* hard-coded while their priority/direction is data.
 */
export const APP_CAPABILITIES = [
  "discovery_taxonomy_management",
  "view_prediction_diagnostics",
  "view_simulated_execution_diagnostics",
  "view_execution_operations",
  "manage_execution_controls",
  "manage_execution_rollout",
] as const;
export type Capability = (typeof APP_CAPABILITIES)[number];

/**
 * The roles this build understands. Single source of truth — `UserProfile`'s
 * own `role` type is derived from it, so a role added to the database enum
 * without teaching the application about it cannot be silently honored here.
 */
export const APP_ROLES = ["super_admin", "admin", "player"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface CapabilityPolicy {
  capability: Capability;
  allowedRoles: AppRole[];
}

function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/**
 * Validates one stored policy row. Returns `null` — never a partial or
 * defaulted policy — for anything unusable: a missing row, a non-array
 * `allowed_roles`, or an entry this build does not recognize (a typo, or a
 * role from a newer migration this deployment has never heard of).
 *
 * Strict by design: one bad entry invalidates the whole row rather than
 * being dropped from it. A policy nobody can fully interpret is not a
 * narrower policy, it is an unknown one, and the caller must treat unknown
 * as deny. An empty `allowed_roles` array, by contrast, is perfectly
 * well-formed configuration that simply permits nobody.
 */
export function parseCapabilityPolicy(capability: Capability, row: unknown): CapabilityPolicy | null {
  if (row === null || typeof row !== "object") return null;
  const allowedRoles = (row as { allowed_roles?: unknown }).allowed_roles;
  if (!Array.isArray(allowedRoles)) return null;
  if (!allowedRoles.every(isAppRole)) return null;
  return { capability, allowedRoles: allowedRoles as AppRole[] };
}

/**
 * The allow/deny decision. `null` (missing, unreadable or malformed policy)
 * always denies — there is deliberately no fallback to a broader role, and
 * no "if we can't tell, assume super admin" path. Fail closed.
 */
export function policyAllowsRole(policy: CapabilityPolicy | null, role: string): boolean {
  if (policy === null) return false;
  return (policy.allowedRoles as readonly string[]).includes(role);
}
