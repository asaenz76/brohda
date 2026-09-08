// Groups/sorts Events results: local date, then sport, then competition,
// then kickoff time. No DB/network here, pure and unit-testable.
import { ALL_EVENT_SPORTS } from "./sport-meta";
import type { EventSport, LocalFixture } from "./local-browse";

export interface LocalEventCompetitionGroup {
  key: string;
  competitionExternalId: string | null;
  competitionName: string | null;
  competitionCountry: string | null;
  season: string | null;
  isSupported: boolean;
  hasWorkspace: boolean;
  hasOdds: boolean | null;
  fixtures: LocalFixture[];
}

export interface LocalEventSportGroup {
  sport: EventSport;
  competitions: LocalEventCompetitionGroup[];
}

export interface LocalEventDateGroup {
  localDateKey: string;
  sports: LocalEventSportGroup[];
}

function compareCompetitionGroups(a: LocalEventCompetitionGroup, b: LocalEventCompetitionGroup): number {
  const workspaceDiff = Number(b.hasWorkspace) - Number(a.hasWorkspace);
  if (workspaceDiff !== 0) return workspaceDiff;
  const oddsDiff = Number(b.hasOdds === true) - Number(a.hasOdds === true);
  if (oddsDiff !== 0) return oddsDiff;
  return (a.competitionName ?? "").localeCompare(b.competitionName ?? "");
}

function groupBySport(fixtures: LocalFixture[]): LocalEventSportGroup[] {
  const bySport = new Map<EventSport, LocalFixture[]>();
  for (const f of fixtures) {
    const sport = f.sport as EventSport;
    const list = bySport.get(sport) ?? [];
    list.push(f);
    bySport.set(sport, list);
  }

  // Fixed sport order rather than sorting by volume — a stable, predictable
  // order matters more here than "busiest sport first" for an admin
  // scanning the same page every day.
  return ALL_EVENT_SPORTS.filter((s) => bySport.has(s)).map((sport) => {
    const sportFixtures = bySport.get(sport)!;
    const byCompetition = new Map<string, LocalFixture[]>();
    for (const f of sportFixtures) {
      const key = `${f.competitionExternalId ?? "unknown"}:${f.season ?? ""}`;
      const list = byCompetition.get(key) ?? [];
      list.push(f);
      byCompetition.set(key, list);
    }

    const competitions: LocalEventCompetitionGroup[] = [...byCompetition.entries()]
      .map(([key, groupFixtures]) => {
        const first = groupFixtures[0];
        return {
          key,
          competitionExternalId: first.competitionExternalId,
          competitionName: first.competitionName,
          competitionCountry: first.competitionCountry,
          season: first.season,
          isSupported: first.isSupported,
          hasWorkspace: first.hasWorkspace,
          hasOdds: first.hasOdds,
          fixtures: [...groupFixtures].sort((a, b) => a.scheduledStartUtc.localeCompare(b.scheduledStartUtc)),
        };
      })
      .sort(compareCompetitionGroups);

    return { sport, competitions };
  });
}

export function groupAndSortLocalEvents(fixtures: LocalFixture[]): LocalEventDateGroup[] {
  const byDate = new Map<string, LocalFixture[]>();
  for (const f of fixtures) {
    const list = byDate.get(f.localDateKey) ?? [];
    list.push(f);
    byDate.set(f.localDateKey, list);
  }

  return [...byDate.keys()].sort().map((localDateKey) => ({
    localDateKey,
    sports: groupBySport(byDate.get(localDateKey)!),
  }));
}
