import "server-only";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, type UserProfile } from "./session";
import { parseCapabilityPolicy, policyAllowsRole, type Capability, type CapabilityPolicy } from "./capability-policy";

/**
 * Capability authorization: the one place that turns "may this user use
 * capability X" into a yes/no, by reading the configured policy from
 * `capability_policies` (migration 20260101000140). Milestone 2 final
 * standing-rule remediation — no feature, and nothing in this file either,
 * contains a role comparison for a mutable policy.
 *
 * Reads through the service-role admin client rather than the cookie-bound
 * RLS client, for the same reason `getFreshnessPolicy()` does
 * (lib/prediction-markets/discovery/policy.ts): `capability_policies` is
 * deliberately not readable by anon/authenticated at all, and a policy read
 * must work from a script, a job or a test, not only inside a live request.
 * Authentication is unaffected — the caller's identity still comes from
 * `requireUser()`, which reads the real session.
 */

// Re-exported so a feature's authorization module can name the profile type
// without importing the session module itself — the capability module is the
// whole auth surface a feature needs to touch.
export type { UserProfile };

/**
 * Loads one capability's policy. Returns `null` for every unusable state —
 * row missing, query failed, or contents this build cannot fully interpret
 * — which `policyAllowsRole` turns into a denial. There is no cached copy
 * and no in-code default to fall back to; an unreadable policy is a denial,
 * never a broader one.
 */
export async function loadCapabilityPolicy(capability: Capability): Promise<CapabilityPolicy | null> {
  let row: unknown = null;
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("capability_policies")
      .select("capability, allowed_roles")
      .eq("capability", capability)
      .maybeSingle();
    if (error) return null;
    row = data;
  } catch {
    return null;
  }
  return parseCapabilityPolicy(capability, row);
}

/** Boolean form, for callers that need to ask without redirecting (tests, future UI affordances). */
export async function roleHasCapability(role: string, capability: Capability): Promise<boolean> {
  return policyAllowsRole(await loadCapabilityPolicy(capability), role);
}

/**
 * The gate itself, shaped exactly like `requireSuperAdmin()`/
 * `requireAdminOrAbove()` (lib/auth/session.ts) so it drops into a Server
 * Action or a page the same way: authenticate first (unauthenticated users
 * still go to /login via `requireUser()`), then consult configuration, then
 * send a denied user to /feed.
 */
export async function requireCapability(capability: Capability): Promise<UserProfile> {
  const profile = await requireUser();
  if (!(await roleHasCapability(profile.role, capability))) {
    redirect("/feed");
  }
  return profile;
}
