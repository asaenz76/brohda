import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { ImportedFixturesList } from "../../fixtures/imported-fixtures-list";
import { ProviderLookup } from "./provider-lookup";

// Phase 4 (spec §18/§20/§33): the fixture-troubleshooting home under Data
// Management. Everyday event browsing lives at /admin/events now — this
// page exists for the exceptional case ("Can't find an event?") and for
// direct fixture-record management (hide/unhide/delete). Reuses the exact
// same server-side raw fixtures query /admin/fixtures/page.tsx used
// (unscoped by sport — a super-admin troubleshooting this list needs to
// see NFL rows here too, unlike Events' curated/supported-only default).
export default async function AdminDataFixturesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();
  const params = await searchParams;
  const showArchived = params.archived === "1";

  const providerEnabled = apiFootballProvider.isEnabled();

  const fixturesQuery = supabase
    .from("fixtures")
    .select(
      "id, external_fixture_id, sport, home_team_name, away_team_name, competition_name, competition_country, scheduled_start_utc, hidden_from_pool_creation",
    )
    .order("scheduled_start_utc", { ascending: false });

  const [fixturesResult, poolsResult] = await Promise.all([
    showArchived
      ? fixturesQuery.in("internal_status", TERMINAL_STATUSES)
      : fixturesQuery.not("internal_status", "in", `(${TERMINAL_STATUSES.join(",")})`),
    supabase.from("pools").select("fixture_id").not("fixture_id", "is", null),
  ]);
  // This page exists specifically to answer "is this fixture actually
  // missing" — a query failure rendering as an empty list would tell the
  // admin exactly the wrong thing (spec §9/§10: a DB failure must never
  // masquerade as "there are no fixtures").
  if (fixturesResult.error || poolsResult.error) {
    console.error("[AdminDataFixturesPage] failed to load fixtures/pools", { fixturesError: fixturesResult.error, poolsError: poolsResult.error });
  }
  const loadFailed = Boolean(fixturesResult.error || poolsResult.error);
  const fixtures = fixturesResult.data;
  const pools = poolsResult.data;

  const poolCountByFixtureId = new Map<string, number>();
  for (const pool of pools ?? []) {
    const fixtureId = pool.fixture_id as string;
    poolCountByFixtureId.set(fixtureId, (poolCountByFixtureId.get(fixtureId) ?? 0) + 1);
  }

  const importedFixtures = (fixtures ?? []).map((f) => ({
    id: f.id as string,
    externalFixtureId: f.external_fixture_id as string,
    sport: f.sport as string | null,
    homeTeamName: f.home_team_name as string,
    awayTeamName: f.away_team_name as string,
    competitionName: f.competition_name as string | null,
    competitionCountry: f.competition_country as string | null,
    scheduledStartUtc: f.scheduled_start_utc as string,
    poolCount: poolCountByFixtureId.get(f.id as string) ?? 0,
    hidden: f.hidden_from_pool_creation as boolean,
  }));

  const archivedToggleParams = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (showArchived) archivedToggleParams.delete("archived");
  else archivedToggleParams.set("archived", "1");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Fixture troubleshooting</h1>
        <p className="text-sm text-text-muted">
          For the exceptional case — a specific event that should exist but isn&apos;t showing up in{" "}
          <Link href="/admin/events" className="text-accent-primary hover:underline">
            Events
          </Link>
          . Normal browsing never needs this page.
        </p>
      </div>

      <ProviderLookup providerDisabled={!providerEnabled} />

      <div className="flex justify-end border-t border-border-subtle pt-4">
        <Link href={`?${archivedToggleParams.toString()}`} className="text-xs font-medium text-accent-primary hover:underline">
          {showArchived ? "View active fixtures" : "View archived fixtures"}
        </Link>
      </div>
      {loadFailed ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          <p className="font-medium">Fixture data could not be loaded.</p>
          <p className="mt-1 text-text-muted">Try reloading the page. If this keeps happening, check server logs.</p>
        </div>
      ) : (
        <ImportedFixturesList fixtures={importedFixtures} isSuperAdmin={isSuperAdmin} heading={showArchived ? "Archived fixtures" : "Imported fixtures"} />
      )}
    </div>
  );
}
