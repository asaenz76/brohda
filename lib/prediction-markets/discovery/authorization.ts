import "server-only";
import { requireCapability, type UserProfile } from "@/lib/auth/capabilities";

/**
 * The single capability boundary for discovery taxonomy management.
 *
 * Authorization itself is a true invariant — taxonomy mutation must always
 * be gated, and every mutating Server Action
 * (lib/actions/discovery-categories.ts) plus the admin page calls THIS
 * function, never an auth helper directly. What is NOT an invariant is
 * which administrative role satisfies the gate: that is mutable product
 * policy ("should ordinary admins, not just super admins, manage
 * categories?"), and under the standing hard-coding rule it must be
 * answerable without editing or deploying source.
 *
 * So this function no longer decides anything. It names the capability and
 * asks the configured policy (`capability_policies`, migration
 * 20260101000140, read by lib/auth/capabilities.ts). Today that policy
 * permits `super_admin` only; permitting `admin` as well, and later
 * reverting, are data changes through the protected operational path
 * (`pnpm set-capability-policy`) — no code, no deployment. A missing,
 * unreadable or malformed policy denies.
 *
 * Nothing in this feature — this file included — contains the allowed-role
 * list.
 */
export async function requireDiscoveryTaxonomyManager(): Promise<UserProfile> {
  return requireCapability("discovery_taxonomy_management");
}
