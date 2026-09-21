import { requirePredictionDiagnosticsViewer } from "@/lib/predictions/authorization";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone 3 admin/diagnostic support (roadmap STEP 24) — read-only,
// deliberately. No edit, no delete, no grading override exists here or
// anywhere else in this codebase; historical Prediction records are not
// casually editable through the admin UI. Uses the admin client (not the
// cookie-bound RLS client) because RLS on `predictions` only permits a
// user to read their OWN rows (migration 20260101000141) — this page's own
// requirePredictionDiagnosticsViewer() gate is what authorizes the
// cross-user read, the same "RLS restricts reads, the page/action
// authorizes" split already used by
// app/(app)/profile/predictions-tab.tsx for cross-user profile viewing.
//
// Milestone 3 final standing-rule remediation, Finding 1: this page no
// longer gates on requireSuperAdmin() directly — which administrative role
// may view Prediction diagnostics is configurable policy
// (capability_policies, migration 20260101000143), not a role name baked
// into this feature. See lib/predictions/authorization.ts.
export default async function AdminPredictionsPage() {
  await requirePredictionDiagnosticsViewer();
  const admin = createAdminClient();
  const { data: predictions } = await admin
    .from("predictions")
    .select(
      "id, user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot, lifecycle_state, result, graded_at, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Predictions</h1>
      <p className="text-sm text-text-secondary">
        Read-only diagnostic view of the 200 most recent Predictions. Historical records are never editable here.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Market</th>
              <th className="px-3 py-2 font-medium">Selected</th>
              <th className="px-3 py-2 font-medium">Snapshot (YES / NO)</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">Graded</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(predictions ?? []).map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{new Date(p.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-text-secondary">{p.user_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-text-secondary">{p.market_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-text-primary">{p.selected_outcome}</td>
                <td className="px-3 py-2 text-text-secondary">
                  {Math.round(Number(p.yes_probability_snapshot) * 100)}% / {Math.round(Number(p.no_probability_snapshot) * 100)}%
                </td>
                <td className="px-3 py-2 text-text-secondary">{p.lifecycle_state}</td>
                <td className="px-3 py-2 text-text-secondary">{p.result ?? "—"}</td>
                <td className="px-3 py-2 text-text-secondary">{p.graded_at ? new Date(p.graded_at).toLocaleString() : "—"}</td>
              </tr>
            ))}
            {(!predictions || predictions.length === 0) && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-muted">
                  No predictions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
