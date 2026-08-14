// Groups/sorts local-browse results (Phase 2) the same way the old
// provider-backed date-first discovery did — local date, then competition,
// then kickoff time — but over LocalFixture instead of EnrichedFixture.
// No DB/network here, pure and unit-testable.
import { compareCompetitionGroup, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";
import type { LocalFixture } from "./local-browse";

export interface LocalCompetitionGroup {
  key: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  season: string | null;
  group: CompetitionGroup | null;
  isSupported: boolean;
  hasWorkspace: boolean;
  hasOdds: boolean | null;
  fixtures: LocalFixture[];
}

export interface LocalDateGroup {
  localDateKey: string;
  competitions: LocalCompetitionGroup[];
}

const UNSUPPORTED_RANK = 2;

function groupRank(group: CompetitionGroup | null): number {
  if (!group) return UNSUPPORTED_RANK;
  return group === "GLOBAL" ? 0 : 1;
}

function compareLocalCompetitionGroups(a: LocalCompetitionGroup, b: LocalCompetitionGroup): number {
  const groupDiff = a.group && b.group ? compareCompetitionGroup(a.group, b.group) : groupRank(a.group) - groupRank(b.group);
  if (groupDiff !== 0) return groupDiff;
  const workspaceDiff = Number(b.hasWorkspace) - Number(a.hasWorkspace);
  if (workspaceDiff !== 0) return workspaceDiff;
  const oddsDiff = Number(b.hasOdds === true) - Number(a.hasOdds === true);
  if (oddsDiff !== 0) return oddsDiff;
  return (a.competitionName ?? "").localeCompare(b.competitionName ?? "");
}

export function groupAndSortLocalFixtures(fixtures: LocalFixture[]): LocalDateGroup[] {
  const byDate = new Map<string, LocalFixture[]>();
  for (const f of fixtures) {
    const list = byDate.get(f.localDateKey) ?? [];
    list.push(f);
    byDate.set(f.localDateKey, list);
  }

  return [...byDate.keys()].sort().map((localDateKey) => {
    const dateFixtures = byDate.get(localDateKey)!;
    const byCompetition = new Map<string, LocalFixture[]>();
    for (const f of dateFixtures) {
      const key = `${f.competitionExternalId ?? "unknown"}:${f.season ?? ""}`;
      const list = byCompetition.get(key) ?? [];
      list.push(f);
      byCompetition.set(key, list);
    }

    const competitions: LocalCompetitionGroup[] = [...byCompetition.entries()]
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
      .sort(compareLocalCompetitionGroups);

    return { localDateKey, competitions };
  });
}
