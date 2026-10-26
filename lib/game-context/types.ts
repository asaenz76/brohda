// Brohda 2.1 M3 — Deterministic Game Context. Types shared by the pure computation (no I/O) and the loader.
//
// The contract: Game data -> deterministic facts -> rank facts -> render ONE short line. No model, no web, no randomness. Every sentence is built from
// facts that carry the ids of the stored Games that prove them (`supportingFixtureIds`); a fact that cannot be proven from stored data is never produced.

/** The slice of `fixtures` the computation reads. Names follow the table; the loader maps rows to this shape. */
export interface ContextFixture {
  id: string;
  provider: string;
  sport: string;
  season: string | null;
  round: string | null;
  homeTeamExternalId: string | null;
  awayTeamExternalId: string | null;
  homeTeamName: string;
  awayTeamName: string;
  scheduledStartUtc: string;
  internalStatus: string;
  homeScore: number | null;
  awayScore: number | null;
}

export type FactType =
  | "WIN_STREAK"
  | "LOSS_STREAK"
  | "SEASON_UNBEATEN"
  | "SEASON_WINLESS"
  | "HOME_WIN_STREAK"
  | "HOME_LOSS_STREAK"
  | "AWAY_WIN_STREAK"
  | "AWAY_LOSS_STREAK"
  | "SERIES_SWEEP"
  | "LAST_N"
  | "SERIES_SPLIT"
  | "SERIES_SINGLE";

/** Which team a fact is about: the Game's home team, its away team, or the pairing itself (head-to-head). */
export type FactSide = "HOME" | "AWAY" | "BOTH";

export interface GameContextFact {
  type: FactType;
  side: FactSide;
  /** The team the sentence is about. For a head-to-head the winner (SERIES_SWEEP / SERIES_SINGLE) or the home team (SERIES_SPLIT). */
  subjectTeamName: string;
  opponentTeamName: string;
  /** The numbers the sentence states, by name (e.g. `streak`, `wins`, `losses`, `sample`, `meetings`). */
  values: Readonly<Record<string, number>>;
  season: string;
  /** Always the regular season: the only scope the stored data lets Brohda prove (see `regularSeason` in the sport registry). */
  scope: "REGULAR_SEASON";
  /** The stored Games that prove this fact, most recent first. Never empty. */
  supportingFixtureIds: readonly string[];
  /** Ranking input: larger = more worth saying. */
  score: number;
}

export interface GameContext {
  /** The one line shown to Members. */
  text: string;
  primaryFact: GameContextFact;
  secondaryFact: GameContextFact | null;
  /** Union of the supporting Games of every fact in the sentence, deduplicated, primary's first. */
  supportingFixtureIds: readonly string[];
  /** The final ranking score (primary plus secondary plus any contrast bonus). */
  rank: number;
  metadata: {
    sport: string;
    season: string;
    candidatesConsidered: number;
    candidatesQualifying: number;
    /** `single` / `pair`, and whether a connective sentence was appended. */
    shape: "single" | "single+connective" | "pair" | "pair+connective";
  };
}

/** The product policy. Held in `platform_settings` (game_context_enabled + game_context_config); parsed fail-closed by ./config.ts. */
export interface GameContextConfig {
  enabled: boolean;
  /** Shortest current winning / losing streak worth a sentence. */
  minWinStreak: number;
  minLossStreak: number;
  /** Shortest home-only / road-only streak worth a sentence. */
  minVenueStreak: number;
  /** The window for the "last N" record, and how many of those N must go one way for it to be notable. */
  lastN: number;
  lastNMinDecisive: number;
  seriesEnabled: boolean;
  pairsEnabled: boolean;
  connectiveEnabled: boolean;
  /** A fact must score at least this to be shown at all. */
  minScore: number;
  /** A rendered line longer than this is shortened by dropping the secondary fact / connective, never by cutting a sentence. */
  maxChars: number;
}
