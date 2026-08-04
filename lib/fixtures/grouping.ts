// Pure grouping/sorting for the date-first fixture discovery results —
// no DB/network here, so the exact ordering rules are unit-testable
// against a plain array of already-enriched fixtures.
import { compareCompetitionGroup, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import type { EnrichedFixture } from "./discovery";

// Named distinctly from the imported CompetitionGroup (Global/Costa Rica
// classification) — this is a display grouping bucket (one competition's
// fixtures on one date), a different concept that happens to share a
// generic name.
export interface FixtureCompetitionGroup {
  key: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  season: string | null;
  group: CompetitionGroup | null;
  isSupported: boolean;
  hasWorkspace: boolean;
  hasOdds: boolean | null;
  fixtures: EnrichedFixture[];
}

export interface DateGroup {
  localDateKey: string; // YYYY-MM-DD
  competitions: FixtureCompetitionGroup[];
}

const UNSUPPORTED_RANK = 2; // after both real groups (GLOBAL=0, COSTA_RICA=1 via compareCompetitionGroup)

function groupRank(group: CompetitionGroup | null): number {
  if (!group) return UNSUPPORTED_RANK;
  return group === "GLOBAL" ? 0 : 1;
}

function compareFixtureCompetitionGroups(a: FixtureCompetitionGroup, b: FixtureCompetitionGroup): number {
  const groupDiff = a.group && b.group ? compareCompetitionGroup(a.group, b.group) : groupRank(a.group) - groupRank(b.group);
  if (groupDiff !== 0) return groupDiff;

  // Within the same group: an already-managed Competition Workspace
  // first, then confirmed odds availability, then alphabetical — matches
  // the spec's explicit within-group ordering exactly.
  const workspaceDiff = Number(b.hasWorkspace) - Number(a.hasWorkspace);
  if (workspaceDiff !== 0) return workspaceDiff;

  const oddsDiff = Number(b.hasOdds === true) - Number(a.hasOdds === true);
  if (oddsDiff !== 0) return oddsDiff;

  return (a.competitionName ?? "").localeCompare(b.competitionName ?? "");
}

/**
 * Groups by local event date (ascending, YYYY-MM-DD sorts correctly as a
 * plain string), then by competition within each date per the group/
 * workspace/odds/alphabetical order above (Global, then Costa Rica, then
 * any unsupported competitions visible via the "Include unsupported"
 * toggle, last), then by kickoff time ascending within each competition.
 * Never leaves the result in raw provider-response order.
 */
export function groupAndSortFixtures(fixtures: EnrichedFixture[]): DateGroup[] {
  const byDate = new Map<string, EnrichedFixture[]>();
  for (const f of fixtures) {
    const list = byDate.get(f.localDateKey) ?? [];
    list.push(f);
    byDate.set(f.localDateKey, list);
  }

  return [...byDate.keys()].sort().map((localDateKey) => {
    const dateFixtures = byDate.get(localDateKey)!;
    const byCompetition = new Map<string, EnrichedFixture[]>();
    for (const f of dateFixtures) {
      const key = `${f.competitionExternalId ?? "unknown"}:${f.season ?? ""}`;
      const list = byCompetition.get(key) ?? [];
      list.push(f);
      byCompetition.set(key, list);
    }

    const competitions: FixtureCompetitionGroup[] = [...byCompetition.entries()]
      .map(([key, groupFixtures]) => {
        const first = groupFixtures[0];
        return {
          key,
          competitionExternalId: first.competitionExternalId,
          competitionName: first.competitionName,
          competitionCountry: first.competitionCountry,
          season: first.season,
          group: first.group,
          isSupported: first.isSupported,
          hasWorkspace: first.hasWorkspace,
          hasOdds: first.hasOdds,
          fixtures: [...groupFixtures].sort((a, b) => a.scheduledStartUtc.localeCompare(b.scheduledStartUtc)),
        };
      })
      .sort(compareFixtureCompetitionGroups);

    return { localDateKey, competitions };
  });
}
