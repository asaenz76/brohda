import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { NFL_PROVIDER } from "@/lib/sports-data/supported-nfl-competitions";

// Phase 4 (spec §15/§20): NFL had zero admin visibility before this —
// sync is entirely cron-driven (sync-fixtures-nfl, every 5 minutes) with
// no admin trigger, and no admin surface showed its state beyond the
// Settings page's Provider Status card. This page doesn't add an import/
// sync action (there isn't a manual one to expose — NFL is a single
// always-on competition, not a many-leagues discovery problem the way
// football is); it's read-only status so an admin troubleshooting "why
// isn't an NFL game showing up" has somewhere to look before assuming
// something is broken. Zero provider calls — DB-only, same discipline as
// every other page in Data Management.
export default async function AdminDataNflPage() {
  await requireAdminOrAbove();
  const supabase = await createClient();

  const importResult = await supabase
    .from("league_season_imports")
    .select("season, sync_status, last_synced_at, last_sync_error, fixture_count_imported, upcoming_fixture_count, import_status")
    .eq("provider", NFL_PROVIDER)
    .eq("external_league_id", "1")
    .order("season", { ascending: false })
    .limit(1)
    .maybeSingle();

  const fixtureCountResult = await supabase
    .from("fixtures")
    .select("id", { count: "exact", head: true })
    .eq("provider", NFL_PROVIDER);

  // This page exists to answer "why isn't an NFL game showing up" — a
  // query failure rendering as "No NFL season has been synced yet." would
  // tell the admin something affirmatively wrong (spec §9/§10), not just
  // uninformative.
  if (importResult.error || fixtureCountResult.error) {
    console.error("[AdminDataNflPage] failed to load NFL sync status", { importError: importResult.error, fixtureCountError: fixtureCountResult.error });
  }
  const loadFailed = Boolean(importResult.error || fixtureCountResult.error);
  const importRow = importResult.data;
  const fixtureCount = fixtureCountResult.count;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">NFL</h1>
        <p className="text-sm text-text-muted">
          NFL sync is fully automatic (cron, every 5 minutes) — there is no manual import or discovery action to trigger here. This is status only, read
          from the local database.
        </p>
      </div>

      {loadFailed ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <p className="font-medium">NFL sync status could not be loaded.</p>
          <p className="mt-1 text-text-muted">Try reloading the page. If this keeps happening, check server logs.</p>
        </div>
      ) : importRow ? (
        <dl className="grid grid-cols-1 gap-4 rounded-lg border border-border-subtle p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Season</dt>
            <dd className="text-text-primary">{importRow.season}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Import status</dt>
            <dd className="text-text-primary">{importRow.import_status}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Sync status</dt>
            <dd className="text-text-primary">{importRow.sync_status}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Last synced</dt>
            <dd className="text-text-primary">{importRow.last_synced_at ? new Date(importRow.last_synced_at).toLocaleString() : "Never"}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Fixtures imported (this season)</dt>
            <dd className="text-text-primary">{importRow.fixture_count_imported}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Upcoming fixtures</dt>
            <dd className="text-text-primary">{importRow.upcoming_fixture_count}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">Total NFL fixtures in database</dt>
            <dd className="text-text-primary">{fixtureCount ?? 0}</dd>
          </div>
          {importRow.last_sync_error && (
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium uppercase tracking-wide text-danger">Last sync error</dt>
              <dd className="font-mono text-xs text-danger">{importRow.last_sync_error}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="rounded-lg border border-border-subtle p-4 text-sm text-text-muted">No NFL season has been synced yet.</p>
      )}

      <p className="text-sm text-text-muted">
        For provider connection health (quota, circuit breaker, last error) and a manual test-connection action, see{" "}
        <Link href="/admin/settings" className="text-accent-primary hover:underline">
          Settings → Provider Status
        </Link>
        .
      </p>
    </div>
  );
}
