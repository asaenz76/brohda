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

/** "Washington Commanders @ Indianapolis Colts" / "Arsenal vs Chelsea" — the one matchup string, in the sport's own order. */
export function formatMatchup(sport: string, home: string, away: string): string {
  const [first, second] = orderTeamsForDisplay(sport, home, away);
  return `${first} ${getMatchupSeparator(sport)} ${second}`;
}

/** "Washington Commanders at Indianapolis Colts" / "Arsenal vs Chelsea" — the matchup as it is read aloud (assistive technology, labels). */
export function formatMatchupSpoken(sport: string, home: string, away: string): string {
  const [first, second] = orderTeamsForDisplay(sport, home, away);
  return `${first} ${isAwayFirstSport(sport) ? "at" : "vs"} ${second}`;
}

/** Scores in the matchup's own order: "10-24" for an American-football game read Away @ Home, "24-10" for a Home-vs-Away one. */
export function formatMatchupScores(sport: string, homeScore: number, awayScore: number, separator = "-"): string {
  const [first, second] = orderTeamsForDisplay(sport, homeScore, awayScore);
  return `${first}${separator}${second}`;
}

export function orderTeamsForDisplay<T>(sport: string, home: T, away: T): [first: T, second: T] {
  return isAwayFirstSport(sport) ? [away, home] : [home, away];
}
