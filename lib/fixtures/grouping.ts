// Pure grouping/sorting for the date-first fixture discovery results —
// no DB/network here, so the exact ordering rules are unit-testable
// against a plain array of already-enriched fixtures.
import type { LeagueTier } from "@/lib/sports-data/priority-leagues";
import type { EnrichedFixture } from "./discovery";

export interface CompetitionGroup {
  key: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  season: string | null;
  tier: LeagueTier | null;
  hasWorkspace: boolean;
  hasOdds: boolean | null;
  fixtures: EnrichedFixture[];
}

export interface DateGroup {
  localDateKey: string; // YYYY-MM-DD
  competitions: CompetitionGroup[];
}

const TIER_RANK: Record<LeagueTier, number> = { A: 0, B: 1, C: 2 };
const UNTIERED_RANK = 3;

function tierRank(tier: LeagueTier | null): number {
  return tier ? TIER_RANK[tier] : UNTIERED_RANK;
}

function compareCompetitionGroups(a: CompetitionGroup, b: CompetitionGroup): number {
  const tierDiff = tierRank(a.tier) - tierRank(b.tier);
  if (tierDiff !== 0) return tierDiff;

  // Within the same tier: an already-managed Competition Workspace first,
  // then confirmed odds availability, then alphabetical — matches the
  // spec's explicit within-tier ordering exactly.
  const workspaceDiff = Number(b.hasWorkspace) - Number(a.hasWorkspace);
  if (workspaceDiff !== 0) return workspaceDiff;

  const oddsDiff = Number(b.hasOdds === true) - Number(a.hasOdds === true);
  if (oddsDiff !== 0) return oddsDiff;

  return (a.competitionName ?? "").localeCompare(b.competitionName ?? "");
}

/**
 * Groups by local event date (ascending, YYYY-MM-DD sorts correctly as a
 * plain string), then by competition within each date per the tier/
 * workspace/odds/alphabetical order above, then by kickoff time ascending
 * within each competition. Never leaves the result in raw provider-
 * response order.
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

    const competitions: CompetitionGroup[] = [...byCompetition.entries()]
      .map(([key, groupFixtures]) => {
        const first = groupFixtures[0];
        return {
          key,
          competitionExternalId: first.competitionExternalId,
          competitionName: first.competitionName,
          competitionCountry: first.competitionCountry,
          season: first.season,
          tier: first.tier,
          hasWorkspace: first.hasWorkspace,
          hasOdds: first.hasOdds,
          fixtures: [...groupFixtures].sort((a, b) => a.scheduledStartUtc.localeCompare(b.scheduledStartUtc)),
        };
      })
      .sort(compareCompetitionGroups);

    return { localDateKey, competitions };
  });
}
