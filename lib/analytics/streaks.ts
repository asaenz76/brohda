// Pure streak math over a list of graded entries, most-recent-first
// (matching get_user_entry_history's `recent` ordering). Voids/refunds
// are skipped when computing streaks — they neither break nor extend a
// win/loss run — per the spec's explicit recommendation, but they still
// appear in the rendered timeline (see toStreakSymbols below).

export interface GradedOutcome {
  status: "WON" | "LOST" | "VOID" | "REFUNDED";
}

export interface StreakSummary {
  // Positive = current winning streak length, negative = current losing
  // streak length, 0 = no graded entries yet.
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

function isGraded(e: GradedOutcome): e is { status: "WON" | "LOST" } {
  return e.status === "WON" || e.status === "LOST";
}

export function computeStreaks(entriesMostRecentFirst: GradedOutcome[]): StreakSummary {
  const graded = entriesMostRecentFirst.filter(isGraded);

  let currentStreak = 0;
  if (graded.length > 0) {
    const firstResult = graded[0].status;
    let count = 0;
    for (const entry of graded) {
      if (entry.status !== firstResult) break;
      count++;
    }
    currentStreak = firstResult === "WON" ? count : -count;
  }

  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let runLength = 0;
  let runStatus: "WON" | "LOST" | null = null;
  // Order-invariant: a maximal consecutive run is the same run whether
  // scanned oldest-first or most-recent-first, only its internal
  // direction flips — so this can walk the already most-recent-first list
  // directly without re-sorting.
  for (const entry of graded) {
    if (entry.status === runStatus) {
      runLength++;
    } else {
      runStatus = entry.status;
      runLength = 1;
    }
    if (runStatus === "WON") longestWinStreak = Math.max(longestWinStreak, runLength);
    else longestLossStreak = Math.max(longestLossStreak, runLength);
  }

  return { currentStreak, longestWinStreak, longestLossStreak };
}

export type StreakSymbol = "W" | "L" | "V";

export function toStreakSymbols(entriesMostRecentFirst: GradedOutcome[]): StreakSymbol[] {
  return entriesMostRecentFirst.map((e) => (e.status === "WON" ? "W" : e.status === "LOST" ? "L" : "V"));
}
