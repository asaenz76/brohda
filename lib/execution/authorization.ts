import "server-only";
import { requireCapability, type UserProfile } from "@/lib/auth/capabilities";

/**
 * The single capability boundary for simulated-execution diagnostics
 * (app/(admin)/admin/simulated-execution/page.tsx). Capability-driven from
 * the start — learning directly from Prediction diagnostics' own two-pass
 * remediation of the identical mistake (a direct requireSuperAdmin() call).
 * Which role satisfies this is configured policy (`capability_policies`,
 * migrations 20260101000150/151), changed via `pnpm set-capability-policy`
 * with no source edit or deployment. Today that policy permits
 * `super_admin` only.
 */
export async function requireSimulatedExecutionDiagnosticsViewer(): Promise<UserProfile> {
  return requireCapability("view_simulated_execution_diagnostics");
}

/**
 * Milestone 5.5 operational surfaces — same capability-driven discipline,
 * three distinct capabilities per STEP 31's own "do not create more
 * capabilities than necessary" instruction: viewing the dashboard is
 * separate from mutating kill switches/provider-health overrides, which is
 * separate from mutating rollout cohorts. All three default to
 * super_admin via `capability_policies` (migrations 20260101000157/158).
 */
export async function requireExecutionOperationsViewer(): Promise<UserProfile> {
  return requireCapability("view_execution_operations");
}

export async function requireExecutionControlsManager(): Promise<UserProfile> {
  return requireCapability("manage_execution_controls");
}

export async function requireExecutionRolloutManager(): Promise<UserProfile> {
  return requireCapability("manage_execution_rollout");
}
