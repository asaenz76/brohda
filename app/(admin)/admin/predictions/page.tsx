import { requirePredictionDiagnosticsViewer } from "@/lib/predictions/authorization";
import { ADMIN_PREDICTIONS_LIMIT, hasActiveAdminPredictionFilters, listAdminPredictionRows, parseAdminPredictionFilters } from "@/lib/predictions/admin-rows";
import { AdminPredictionsTable } from "@/components/admin/AdminPredictionsTable";
import { AdminPredictionsFilters } from "@/components/admin/AdminPredictionsFilters";

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
//
// Search and filters are server-side (admin_search_predictions, a bounded query with real joins) and live in the URL; the result is
// still capped at the most recent ADMIN_PREDICTIONS_LIMIT matches, with every id still shown beside the names.
export default async function AdminPredictionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePredictionDiagnosticsViewer();
  const filters = parseAdminPredictionFilters(await searchParams);
  const filtered = hasActiveAdminPredictionFilters(filters);
  const rows = await listAdminPredictionRows(ADMIN_PREDICTIONS_LIMIT, undefined, filters);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Predictions</h1>
      <p className="text-sm text-text-secondary">
        Read-only diagnostic view of the {ADMIN_PREDICTIONS_LIMIT} most recent {filtered ? "matching " : ""}Predictions. Historical records are never editable here. Each row
        shows the user, Game and Market by name, with the short ids alongside (hover for the full id).
      </p>
      <AdminPredictionsFilters filters={filters} />
      <p role="status" aria-live="polite" className="text-sm text-text-muted">
        {filtered ? `${rows.length} matching prediction${rows.length === 1 ? "" : "s"}${rows.length === ADMIN_PREDICTIONS_LIMIT ? " (showing the most recent; narrow the search to see others)" : ""}` : `Showing the ${rows.length} most recent`}
      </p>
      <AdminPredictionsTable rows={rows} emptyMessage={filtered ? "No predictions match these filters." : undefined} />
    </div>
  );
}
