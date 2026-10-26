import { getSportConfig } from "@/lib/sports-data/sport-registry";
import { generateCandidates } from "./facts";
import { selectFacts } from "./rank";
import { assemble } from "./render";
import type { ContextFixture, GameContext, GameContextConfig } from "./types";

// Brohda 2.1 M3 — Game Context for ONE upcoming Game, from stored fixtures only. Pure: same fixtures + same config = the same answer, always (no clock, no randomness, no I/O).
//
// Returns null — "say nothing" — whenever the Game is not eligible, the history cannot prove a fact, or no fact clears the configured bar. Null is a normal, correct outcome.

/** The Game itself must be a regular-season Game of a sport whose stored data can prove regular-season form, not yet started, with two distinct identified teams and a season. */
export function eligibleTarget(target: ContextFixture): { season: string; homeId: string; awayId: string } | null {
  const prefix = getSportConfig(target.sport)?.regularSeason?.roundPrefix;
  if (!prefix) return null;
  if (target.internalStatus !== "NOT_STARTED") return null;
  if (!target.season || !target.round || !target.round.startsWith(prefix)) return null;
  if (!target.homeTeamExternalId || !target.awayTeamExternalId || target.homeTeamExternalId === target.awayTeamExternalId) return null;
  if (Number.isNaN(Date.parse(target.scheduledStartUtc))) return null;
  return { season: target.season, homeId: target.homeTeamExternalId, awayId: target.awayTeamExternalId };
}

export function computeGameContext(target: ContextFixture, history: readonly ContextFixture[], config: GameContextConfig): GameContext | null {
  if (!config.enabled) return null;
  const eligible = eligibleTarget(target);
  if (!eligible) return null;

  const candidates = generateCandidates(target, history, config, eligible.season, eligible.homeId, eligible.awayId);
  const selection = selectFacts(candidates, config);
  if (!selection) return null;
  const line = assemble(selection.primary, selection.secondary, config);
  if (!line) return null;

  // If the pair was too long and only the single fact is shown, the line is about the primary fact alone and says so: no secondary, and the rank is the primary's.
  const paired = line.shape === "pair" || line.shape === "pair+connective";
  const secondaryFact = paired ? selection.secondary : null;
  const supporting = [...new Set([...selection.primary.supportingFixtureIds, ...(secondaryFact?.supportingFixtureIds ?? [])])];
  return {
    text: line.text,
    primaryFact: selection.primary,
    secondaryFact,
    supportingFixtureIds: supporting,
    rank: paired ? selection.rank : selection.primary.score,
    metadata: { sport: target.sport, season: eligible.season, candidatesConsidered: candidates.length, candidatesQualifying: selection.qualifying, shape: line.shape },
  };
}

/** Many Games over one shared pool of history rows (the loader reads that pool once). Each Game is independent; the Map is keyed by fixture id and holds only Games that HAVE a line. */
export function computeGameContexts(targets: readonly ContextFixture[], history: readonly ContextFixture[], config: GameContextConfig): Map<string, GameContext> {
  const out = new Map<string, GameContext>();
  if (!config.enabled) return out;
  for (const target of targets) {
    const context = computeGameContext(target, history, config);
    if (context) out.set(target.id, context);
  }
  return out;
}
