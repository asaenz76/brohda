import type { PredictionOutcome } from "@/lib/predictions/types";
import { getScoreUnit } from "@/lib/sports-data/sport-registry";
import { formatMatchup, orderTeamsForDisplay } from "@/lib/sports-data/team-display-order";
import type { MarketTemplate, MarketYesSide } from "./types";

// THE one place that turns a Market's canonical, binary representation into
// what a person reads and taps. The canonical model never changes: a Pick is
// still stored, graded, locked, compared (Call BS / money opposition) and
// aggregated as "YES" | "NO" against the Market's frozen identity
// (market_template, line_value, yes_side — DB-immutable once set). This
// module only decides the words, deterministically, from that same
// structured data plus the Game's own team names:
//
//   MONEYLINE  yes_side's team wins outright (a draw resolves NO — see
//              lib/predictions/sports-resolution.ts)
//                YES = the yes_side team          NO = the other team
//   SPREAD     the line is applied to the yes_side team's score
//                YES = yes_side team, signed line  NO = other team, opposite sign
//   TOTAL      YES always means Over (a fixed template convention)
//                YES = Over <line>                NO = Under <line>
//
// Choices are returned in DISPLAY order, which is not always YES-then-NO:
// for team-based Markets they follow the Game's own matchup order — the
// sport-aware order lib/sports-data/team-display-order.ts already defines
// for every other Game display ("Away @ Home" for American football), so
// the two buttons read like the matchup no matter which side YES happens to
// be. Every consumer must render
// from `choices` and carry `outcome` for state — never infer a selection from
// a label, and never assume position 0 is YES.
//
// Nothing here parses a question string or hard-codes a team, side or line.
// When the structured data needed for a template-aware label is not all
// there (a historical or unsupported Market), it falls back to the label the
// ingestion run authored on `markets.price_outcome_labels`, and from there to
// a plain "Yes"/"No" — it never guesses. Pure, no I/O.

export interface SelectionLabelSource {
  marketTemplate?: MarketTemplate | null;
  lineValue?: number | null;
  yesSide?: MarketYesSide | null;
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  /** The Game's sport, which decides the matchup order. Unknown → the helper's default (home first). */
  sport?: string | null;
  /** Ingestion-authored labels ("Chiefs win" / "Chiefs do not win"). Fallback only — never read when structured data is complete. */
  priceOutcomeLabels?: { yes: string | null; no: string | null } | null;
}

export interface Choice {
  /** The canonical selection this choice stands for. */
  outcome: PredictionOutcome;
  /** The concise visible label: "Indianapolis Colts", "Patriots +3.5", "Over 47.5". */
  label: string;
  /** An unambiguous name for assistive technology: "Pick Indianapolis Colts to win". */
  accessibleName: string;
}

export interface ChoicePresentation {
  /** Both choices, in display order. */
  choices: [Choice, Choice];
  /** A compact label for the Market itself ("Moneyline", "Spread", "Total 47.5"), or null when the template is unknown. */
  marketLabel: string | null;
  /** True when the labels came from the template + Game data; false for the legacy/generic fallback. */
  templateAware: boolean;
}

/** The compact Market labels for the team-based templates. Exported so a surface that wants to treat one specially (a Moneyline needs no label on a single-Market card) compares against this, not a copy of the word. */
export const MONEYLINE_MARKET_LABEL = "Moneyline";
export const SPREAD_MARKET_LABEL = "Spread";

const nonEmpty = (value: string | null | undefined): value is string => typeof value === "string" && value.trim().length > 0;

/** "3.5" / "47" — the exact canonical number, no padding and no rounding. */
function formatLineNumber(value: number): string {
  return String(Number(value));
}

/** The signed spread for a team: +3.5, -3.5, +3, and PK ("pick'em") for a line of exactly zero. */
export function formatSpreadLine(value: number): string {
  const n = Number(value);
  if (n === 0) return "PK";
  return n > 0 ? `+${formatLineNumber(n)}` : `-${formatLineNumber(Math.abs(n))}`;
}

function spokenSpread(team: string, value: number): string {
  const n = Number(value);
  if (n === 0) return `Pick ${team} at pick'em`;
  return `Pick ${team} ${n > 0 ? "plus" : "minus"} ${formatLineNumber(Math.abs(n))}`;
}

function fallback(source: SelectionLabelSource): ChoicePresentation {
  const yes = source.priceOutcomeLabels?.yes;
  const no = source.priceOutcomeLabels?.no;
  const yesLabel = nonEmpty(yes) ? yes : "Yes";
  const noLabel = nonEmpty(no) ? no : "No";
  return {
    choices: [
      { outcome: "YES", label: yesLabel, accessibleName: `Pick ${yesLabel}` },
      { outcome: "NO", label: noLabel, accessibleName: `Pick ${noLabel}` },
    ],
    marketLabel: null,
    templateAware: false,
  };
}

export function getChoicePresentation(source: SelectionLabelSource): ChoicePresentation {
  const { marketTemplate, lineValue, yesSide, homeTeamName, awayTeamName } = source;

  if (marketTemplate === "TOTAL") {
    if (typeof lineValue !== "number" || !Number.isFinite(lineValue)) return fallback(source);
    const line = formatLineNumber(lineValue);
    // What the total is counted in is the sport's own word (points, goals, runs) — from the shared sport registry, never hard-coded here.
    const unit = getScoreUnit(source.sport).plural;
    return {
      choices: [
        { outcome: "YES", label: `Over ${line}`, accessibleName: `Pick Over ${line} total ${unit}` },
        { outcome: "NO", label: `Under ${line}`, accessibleName: `Pick Under ${line} total ${unit}` },
      ],
      marketLabel: `Total ${line}`,
      templateAware: true,
    };
  }

  if (marketTemplate === "MONEYLINE" || marketTemplate === "SPREAD") {
    if ((yesSide !== "HOME" && yesSide !== "AWAY") || !nonEmpty(homeTeamName) || !nonEmpty(awayTeamName)) return fallback(source);
    const yesTeam = yesSide === "HOME" ? homeTeamName : awayTeamName;
    const noTeam = yesSide === "HOME" ? awayTeamName : homeTeamName;

    let yes: Choice;
    let no: Choice;
    if (marketTemplate === "MONEYLINE") {
      yes = { outcome: "YES", label: yesTeam, accessibleName: `Pick ${yesTeam} to win` };
      no = { outcome: "NO", label: noTeam, accessibleName: `Pick ${noTeam} to win` };
    } else {
      if (typeof lineValue !== "number" || !Number.isFinite(lineValue)) return fallback(source);
      // The line belongs to the yes_side team; its opponent carries the opposite sign.
      yes = { outcome: "YES", label: `${yesTeam} ${formatSpreadLine(lineValue)}`, accessibleName: spokenSpread(yesTeam, lineValue) };
      no = { outcome: "NO", label: `${noTeam} ${formatSpreadLine(-lineValue)}`, accessibleName: spokenSpread(noTeam, -lineValue) };
    }
    // Matchup order, from the shared sport-aware helper (not from which side YES is).
    const homeChoice = yesSide === "HOME" ? yes : no;
    const awayChoice = yesSide === "HOME" ? no : yes;
    const [first, second] = orderTeamsForDisplay(source.sport ?? "", homeChoice, awayChoice);
    return { choices: [first, second], marketLabel: marketTemplate === "MONEYLINE" ? MONEYLINE_MARKET_LABEL : SPREAD_MARKET_LABEL, templateAware: true };
  }

  return fallback(source);
}

/** The label a viewer reads for one canonical side of a Market. */
export function getSelectionLabel(source: SelectionLabelSource, outcome: PredictionOutcome): string {
  return getChoicePresentation(source).choices.find((c) => c.outcome === outcome)!.label;
}

/** The accessible name for one canonical side of a Market. */
export function getSelectionAccessibleName(source: SelectionLabelSource, outcome: PredictionOutcome): string {
  return getChoicePresentation(source).choices.find((c) => c.outcome === outcome)!.accessibleName;
}

/**
 * What a Market is *about*, in one human phrase — "Washington Commanders @ Indianapolis Colts · Moneyline", "… · Total 47.5" — for
 * places that name a Market in a sentence (notifications, Profile history). Only when the template-aware label and both team names
 * exist; otherwise the Market's original question, or `fallback`, so nothing is ever guessed.
 */
export function getMarketSubject(source: SelectionLabelSource, question: string | null | undefined, fallback = "a market"): string {
  const presentation = getChoicePresentation(source);
  if (presentation.templateAware && nonEmpty(source.homeTeamName) && nonEmpty(source.awayTeamName) && presentation.marketLabel) {
    return `${formatMatchup(source.sport ?? "", source.homeTeamName, source.awayTeamName)} · ${presentation.marketLabel}`;
  }
  return nonEmpty(question) ? question.trim() : fallback;
}
