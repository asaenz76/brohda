// Milestone R1 (docs/BROHDA_2_0_MILESTONE_MAP.md, Game <-> Market
// Foundation) — the objective, deterministic result of a sports Market
// proposition, computed directly from its linked Game (fixture)'s final
// score. Pure function, no I/O: the caller (lib/predictions/grading.ts)
// supplies both the Market's structural identity and the fixture's current
// state, so this file is fully unit-testable without a database and never
// re-derives "is this fixture done" on its own.
//
// This intentionally bypasses `markets.resolved_outcome` (a raw,
// diagnostic, provider-pass-through field per
// supabase/migrations/20260101000135_prediction_market_foundation.sql's own
// header comment) for any Market that carries a fixture/template — sports
// Market results are computed from Brohda's own normalized Game data, never
// from an externally-set text field. `resolved_outcome` remains on the
// table for non-sports/diagnostic provenance only.

import type { MarketTemplate, MarketYesSide } from "@/lib/prediction-markets/types";
import type { FixtureForGrading } from "@/lib/sports-data/fixture-lookup";

export type SportsMarketOutcome = "YES" | "NO" | "VOID" | "PENDING";

export interface SportsMarketDefinition {
  marketTemplate: MarketTemplate;
  lineValue: number | null;
  yesSide: MarketYesSide | null;
}

// A true objective final. Deterministically resolvable from the score.
const RESOLVABLE_STATUS = "COMPLETED";
// The Game never happened as scheduled — no proposition about it can be
// objectively true. This is a deterministic template-level rule, not a
// guess: an event that was cancelled cannot have a winner, a cover, or a
// total.
const DETERMINISTIC_VOID_STATUS = "CANCELLED";

/**
 * Every other fixture_internal_status value (NOT_STARTED, LIVE, HALFTIME,
 * EXTRA_TIME, PENALTIES, UNKNOWN — genuinely still in progress or not yet
 * started — and POSTPONED, SUSPENDED, ABANDONED, AWARDED) resolves to
 * PENDING here, never a guess. POSTPONED is a genuinely temporary state
 * (the Game will still happen). SUSPENDED/ABANDONED/AWARDED are the R1
 * task's own explicitly-flagged open founder/product decisions — see the
 * R1 completion report's "Game lifecycle" and "Open decisions" sections —
 * and are deliberately left PENDING (never falsely graded) until that
 * policy exists, rather than this file inventing one.
 */
export function computeSportsMarketOutcome(definition: SportsMarketDefinition, fixture: FixtureForGrading): SportsMarketOutcome {
  if (fixture.internalStatus === DETERMINISTIC_VOID_STATUS) return "VOID";
  if (fixture.internalStatus !== RESOLVABLE_STATUS) return "PENDING";
  // Defensive only — a COMPLETED fixture should always carry both scores;
  // never fabricate a result if that invariant is somehow violated.
  if (fixture.homeScore === null || fixture.awayScore === null) return "PENDING";

  const { marketTemplate, lineValue, yesSide } = definition;

  if (marketTemplate === "MONEYLINE") {
    const [yesScore, noScore] = sidesFor(yesSide, fixture);
    // Template rule: MONEYLINE is strictly a two-outcome "does yes_side win
    // outright" proposition. A draw resolves NO (yes_side did not win),
    // not VOID — this is the template's own definition, not an
    // unresolved question. A separate three-way/draw-inclusive template
    // is not implemented (no evidence any current sport/pool requires it).
    return yesScore > noScore ? "YES" : "NO";
  }

  if (marketTemplate === "SPREAD") {
    const line = requireLine(lineValue, "SPREAD");
    const [yesScore, noScore] = sidesFor(yesSide, fixture);
    const adjusted = yesScore + line;
    if (adjusted > noScore) return "YES";
    if (adjusted < noScore) return "NO";
    return "VOID"; // true push: the line landed exactly on the final margin.
  }

  // TOTAL — yesSide is always null here (DB shape constraint); YES means OVER.
  const line = requireLine(lineValue, "TOTAL");
  const total = fixture.homeScore + fixture.awayScore;
  if (total > line) return "YES";
  if (total < line) return "NO";
  return "VOID"; // true push.
}

function sidesFor(yesSide: MarketYesSide | null, fixture: FixtureForGrading): [number, number] {
  // Schema-guaranteed non-null for MONEYLINE/SPREAD (markets_template_shape);
  // the fallback branch exists only so this stays a total function.
  if (yesSide === "AWAY") return [fixture.awayScore as number, fixture.homeScore as number];
  return [fixture.homeScore as number, fixture.awayScore as number];
}

function requireLine(lineValue: number | null, template: MarketTemplate): number {
  if (lineValue === null) throw new Error(`${template} market is missing line_value — schema invariant violated`);
  return lineValue;
}
