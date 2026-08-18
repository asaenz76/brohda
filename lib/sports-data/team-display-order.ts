const AWAY_FIRST_SPORTS = new Set(["american_football"]);

/**
 * Real-world broadcast convention differs by sport: American sports (NFL)
 * list the away team first ("Away @ Home"), while football/soccer lists
 * home first ("Home vs Away"). Centralized here so every fixture display
 * (pool cards, fixture detail, search) agrees, instead of each screen
 * hardcoding its own home-first order.
 */
export function isAwayFirstSport(sport: string): boolean {
  return AWAY_FIRST_SPORTS.has(sport);
}

export function getMatchupSeparator(sport: string): string {
  return isAwayFirstSport(sport) ? "@" : "vs";
}

export function orderTeamsForDisplay<T>(sport: string, home: T, away: T): [first: T, second: T] {
  return isAwayFirstSport(sport) ? [away, home] : [home, away];
}
