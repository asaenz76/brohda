import Link from "next/link";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { TERMINAL_STATUSES } from "@/lib/sports-data/status-map";
import { parseDateRangeParam } from "@/lib/fixtures/date-window";
import { getLocalCompetitionOptions } from "@/lib/fixtures/local-competition-options";
import { ModeTabs, type FixturesMode } from "./mode-tabs";
import { DateMode } from "./date-mode/date-mode";
import { CompetitionMode } from "./competition-mode";
import { FixtureIdMode } from "./fixture-id-mode";
import { ImportedFixturesList } from "./imported-fixtures-list";

function normalizeMode(raw: string | undefined): FixturesMode {
  if (raw === "competition" || raw === "fixture-id") return raw;
  return "date"; // default per spec §0
}

export default async function AdminFixturesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const viewer = await requireAdminOrAbove();
  const isSuperAdmin = viewer.role === "super_admin";
  const supabase = await createClient();
  const params = await searchParams;
  const mode = normalizeMode(params.mode);
  // Folded in from the old standalone /admin/fixture-archive page (launch
  // simplification — one fewer admin destination for the same underlying
  // list, just a different status filter) — ?archived=1 switches the
  // imported-fixtures list below from "still active" to "finished,
  // cancelled, abandoned, or awarded" without changing anything about the
  // discovery modes above it.
  const showArchived = params.archived === "1";

  const providerEnabled = apiFootballProvider.isEnabled();

  const fixturesQuery = supabase
    .from("fixtures")
    .select(
      "id, external_fixture_id, sport, home_team_name, away_team_name, competition_name, competition_country, scheduled_start_utc, hidden_from_pool_creation",
    )
    .order("scheduled_start_utc", { ascending: false });

  const [{ data: fixtures }, { data: pools }, competitionOptions] = await Promise.all([
    showArchived
      ? fixturesQuery.in("internal_status", TERMINAL_STATUSES)
      : fixturesQuery.not("internal_status", "in", `(${TERMINAL_STATUSES.join(",")})`),
    supabase.from("pools").select("fixture_id").not("fixture_id", "is", null),
    mode === "competition" ? getLocalCompetitionOptions() : Promise.resolve([]),
  ]);

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

  // Server-side normalization of date-mode URL params — a malformed
  // preset/date silently falls back to the default rather than ever
  // reaching browseFixturesByDateAction (the local-DB query, spec §2) with
  // bad input; real validation happens again, authoritatively, inside that
  // action (and, for the still-provider-backed explicit discovery panel,
  // inside searchFixturesByDateAction too). This only resolves what
  // DateMode's initial client state should be.
  const initialPreset = parseDateRangeParam(params.range);
  const initialCustomFrom = params.from ?? "";
  const initialCustomTo = params.to ?? "";
  const initialCompetitionExternalId = params.competition ?? "";

  // Preserves every other current param (mode, date-range filters, etc.)
  // while flipping just ?archived — so switching to the archived view from
  // a filtered date-mode search returns to that same search on the way back.
  const archivedToggleParams = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  if (showArchived) {
    archivedToggleParams.delete("archived");
  } else {
    archivedToggleParams.set("archived", "1");
  }
  const archivedToggleQuery = archivedToggleParams.toString();

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Fixtures</h1>
      <ModeTabs mode={mode} />

      {mode === "date" && (
        <DateMode
          providerDisabled={!providerEnabled}
          initialPreset={initialPreset}
          initialCustomFrom={initialCustomFrom}
          initialCustomTo={initialCustomTo}
          initialCompetitionExternalId={initialCompetitionExternalId}
        />
      )}
      {mode === "competition" && <CompetitionMode options={competitionOptions} providerDisabled={!providerEnabled} />}
      {mode === "fixture-id" && <FixtureIdMode providerDisabled={!providerEnabled} />}

      <div className="flex justify-end">
        <Link
          href={`?${archivedToggleQuery}`}
          className="text-xs font-medium text-accent-primary hover:underline"
        >
          {showArchived ? "View active fixtures" : "View archived fixtures"}
        </Link>
      </div>
      <ImportedFixturesList
        fixtures={importedFixtures}
        isSuperAdmin={isSuperAdmin}
        heading={showArchived ? "Archived fixtures" : "Imported fixtures"}
      />
    </div>
  );
}
