import "server-only";
import { requireCapability, type UserProfile } from "@/lib/auth/capabilities";

/**
 * The single capability boundary for Prediction diagnostics
 * (app/(admin)/admin/predictions/page.tsx). Milestone 3 final
 * standing-rule remediation, Finding 1 — mirrors
 * lib/prediction-markets/discovery/authorization.ts's
 * requireDiscoveryTaxonomyManager() exactly: that a check exists is the
 * true invariant; which role satisfies it (`capability_policies`,
 * migration 20260101000143) is configurable, changed via
 * `pnpm set-capability-policy` with no source edit or deployment. Today
 * that policy permits `super_admin` only. Nothing in this file — or
 * anywhere else in the Prediction diagnostics feature — contains the
 * allowed-role list.
 */
export async function requirePredictionDiagnosticsViewer(): Promise<UserProfile> {
  return requireCapability("view_prediction_diagnostics");
}
