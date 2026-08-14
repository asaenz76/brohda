// Phase 2 (local-first football browsing), spec §7: the By-competition
// selector is built from SUPPORTED_COMPETITIONS ∩ league_season_imports —
// never a live provider league catalog. A supported competition with no
// matching (IMPORTED, non-archived) league_season_imports row simply has
// zero entries in `seasons`; the UI renders that as "Not imported" rather
// than this module guessing or fabricating a season.
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  SUPPORTED_COMPETITIONS,
  type CompetitionGroup,
  type CompetitionType,
  type SupportedCompetition,
} from "@/lib/sports-data/supported-competitions";

export interface LocalCompetitionSeasonOption {
  season: string;
  leagueSeasonImportId: string;
  fixtureCountImported: number | null;
  upcomingFixtureCount: number | null;
}

export interface LocalCompetitionOption {
  externalLeagueId: string;
  name: string;
  country: string;
  group: CompetitionGroup;
  type: CompetitionType;
  seasons: LocalCompetitionSeasonOption[];
}

export async function getLocalCompetitionOptions(): Promise<LocalCompetitionOption[]> {
  const adminClient = createAdminClient();
  const enabled = SUPPORTED_COMPETITIONS.filter(
    (c): c is SupportedCompetition & { externalLeagueId: string } => c.enabled && c.externalLeagueId != null,
  );
  const ids = enabled.map((c) => c.externalLeagueId);

  const { data } = await adminClient
    .from("league_season_imports")
    .select("id, external_league_id, season, fixture_count_imported, upcoming_fixture_count")
    .in("external_league_id", ids)
    .eq("import_status", "IMPORTED")
    .is("archived_at", null)
    .order("season", { ascending: false });

  const seasonsByLeague = new Map<string, LocalCompetitionSeasonOption[]>();
  for (const row of data ?? []) {
    const externalLeagueId = row.external_league_id as string;
    const list = seasonsByLeague.get(externalLeagueId) ?? [];
    list.push({
      season: row.season as string,
      leagueSeasonImportId: row.id as string,
      fixtureCountImported: row.fixture_count_imported as number | null,
      upcomingFixtureCount: row.upcoming_fixture_count as number | null,
    });
    seasonsByLeague.set(externalLeagueId, list);
  }

  return enabled.map((c) => ({
    externalLeagueId: c.externalLeagueId,
    name: c.name,
    country: c.country,
    group: c.group,
    type: c.type,
    seasons: seasonsByLeague.get(c.externalLeagueId) ?? [],
  }));
}
