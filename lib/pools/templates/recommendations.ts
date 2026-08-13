import { TEMPLATE_REGISTRY, getLatestTemplate } from "./registry";
import { areMirrors, getQuestionFamily, isExactDuplicate, TEAM_SCOPED_TEMPLATE_IDS, type QuestionCandidate } from "./families";
import type { PoolTemplate } from "./types";
import type { NormalizedFixtureMarkets } from "@/lib/sports-data/types";
import { estimateFromMarkets, ODDS_ALLOWLIST_TEMPLATE_IDS } from "./odds-mapping";
import type { ProbabilityEstimateSource } from "./odds-consensus";

export type { ProbabilityEstimateSource };

/**
 * Publishing guidance only — never settlement logic. Nothing here decides
 * how a pool grades; it decides which questions are worth suggesting to an
 * admin, and which combinations of already-active pools on a fixture are
 * worth warning about before publish. Deliberately kept separate from
 * gradingRule/availabilityCheck so this can evolve (real historical data,
 * AI-assisted scoring, popularity signals) without ever touching what
 * actually resolves a pool.
 */

export interface ActivePoolSummary {
  poolType: string;
  templateId: string | null;
  templateConfig: Record<string, unknown> | null;
}

// Pools in these statuses still compete for real (or soon-to-be-real)
// liquidity on this fixture — DRAFT included, since the whole point is to
// steer an admin away from staging a duplicate before it's even published.
// READY_FOR_REVIEW/SETTLED/VOIDED/CANCELLED/MANUAL_REVIEW/etc. are excluded:
// none of them can take a new entry, so a duplicate against one of those is
// no longer a real liquidity concern.
export const ACTIVE_CONFLICT_STATUSES = ["DRAFT", "OPEN", "LOCKED", "AWAITING_RESULT"] as const;

// ---------------------------------------------------------------------
// Estimated YES probability — static, sport-domain heuristic priors, NOT
// derived from this fixture's actual teams (no historical strength/odds
// data source exists yet). Documented per-template below with the
// reasoning behind each default. Swappable later for a real fixture-aware
// model (historical YES frequency, provider odds, AI estimation, etc.) —
// every call site takes the template id + config only, so a future
// implementation can look up real data without changing any caller.
// ---------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.max(0.02, Math.min(0.98, value));
}

function readNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const raw = config[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function isAway(config: Record<string, unknown>): boolean {
  return config.team === "AWAY";
}

const STATIC_YES_PROBABILITY: Record<string, number> = {
  HOME_TEAM_TO_WIN: 0.45,
  AWAY_TEAM_TO_WIN: 0.29,
  EITHER_TEAM_TO_WIN: 0.74,
  BOTH_TEAMS_TO_SCORE: 0.5,
  PENALTY_AWARDED: 0.28,
  OWN_GOAL: 0.08,
  PLAYER_TO_SCORE: 0.28,
};

/** Returns a probability in [0.02, 0.98] — never exactly 0 or 1, since a
 * template that can never resolve either way wouldn't be offered at all. */
export function estimateYesProbability(templateId: string, config: Record<string, unknown>): number {
  const staticValue = STATIC_YES_PROBABILITY[templateId];
  if (staticValue !== undefined) return staticValue;

  switch (templateId) {
    case "TEAM_TO_AVOID_DEFEAT":
      return isAway(config) ? 0.54 : 0.7;
    case "CLEAN_SHEET":
      return isAway(config) ? 0.24 : 0.32;
    case "WIN_TO_NIL":
      return isAway(config) ? 0.16 : 0.24;
    case "FIRST_TEAM_TO_SCORE":
      return isAway(config) ? 0.34 : 0.44;
    case "RED_CARD":
      return clamp01(0.3 + (config.includeSecondYellowDismissal ? 0.05 : 0));
    case "MATCH_TOTAL_GOALS":
      return clamp01(1.05 - readNumber(config, "minimumGoals", 3) * 0.19);
    case "FIRST_HALF_TOTAL_GOALS":
      return clamp01(0.75 - readNumber(config, "minimumGoals", 1) * 0.22);
    case "TEAM_TOTAL_GOALS": {
      const base = clamp01(0.62 - readNumber(config, "minimumGoals", 1) * 0.16);
      return clamp01(isAway(config) ? base - 0.08 : base);
    }
    case "WINNING_MARGIN": {
      const base = clamp01(0.4 - (readNumber(config, "minimumMargin", 1) - 1) * 0.11);
      return clamp01(isAway(config) ? base - 0.12 : base);
    }
    case "GOAL_AFTER_MINUTE":
      return clamp01(0.95 - readNumber(config, "minute", 45) * 0.006);
    default:
      return 0.5;
  }
}

export interface ProbabilityEstimate {
  probability: number;
  source: ProbabilityEstimateSource;
  bookmakerCount: number;
  bookmakerIds: number[];
  oddsLine: number | null;
  // Null for STATIC_PRIOR; otherwise the odds-mapping.ts market key this
  // estimate came from (e.g. "MATCH_TOTAL_GOALS", "MATCH_WINNER_3WAY").
  marketKey: string | null;
  // Config overrides a real-odds estimate implies (e.g. a market-chosen
  // minimumGoals) — merged into the candidate's config by scoreTemplate.
  // Always null when source is STATIC_PRIOR.
  resolvedConfig: Record<string, unknown> | null;
}

/**
 * Prefers a real bookmaker-consensus estimate (see odds-mapping.ts) for
 * allowlisted templates when live market data is available and clears the
 * consensus bar; falls back to the static prior above otherwise — never a
 * guess in between. `markets` is null whenever odds weren't fetched (no
 * fixture picked yet, provider disabled, fetch failed), in which case this
 * is exactly equivalent to the old static-only estimateYesProbability.
 */
export function estimateYesProbabilityWithSource(
  templateId: string,
  config: Record<string, unknown>,
  markets: NormalizedFixtureMarkets | null,
): ProbabilityEstimate {
  if (markets && ODDS_ALLOWLIST_TEMPLATE_IDS.has(templateId)) {
    const estimate = estimateFromMarkets(templateId, config, markets);
    if (estimate) {
      return {
        probability: estimate.probability,
        source: estimate.source,
        bookmakerCount: estimate.bookmakerCount,
        bookmakerIds: estimate.bookmakerIds,
        oddsLine: estimate.line,
        marketKey: estimate.marketKey,
        resolvedConfig: estimate.resolvedConfig,
      };
    }
  }
  return {
    probability: estimateYesProbability(templateId, config),
    source: "STATIC_PRIOR",
    bookmakerCount: 0,
    bookmakerIds: [],
    oddsLine: null,
    marketKey: null,
    resolvedConfig: null,
  };
}

// ---------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------

export type GradingReliability = "AUTO" | "NEEDS_LIVE_DATA" | "MANUAL";

function gradingReliabilityOf(template: PoolTemplate<Record<string, unknown>>): GradingReliability {
  return template.requiredDataSources.includes("FIXTURE_EVENTS") ? "NEEDS_LIVE_DATA" : "AUTO";
}

const SETTLEMENT_CONFIDENCE_SCORE: Record<GradingReliability, number> = {
  AUTO: 1,
  NEEDS_LIVE_DATA: 0.6,
  MANUAL: 0.2,
};

/** Balance score peaks at exactly 50% and falls off linearly toward the
 * edges — the same signal the star rating and the POOR_BALANCE/VERY_
 * UNBALANCED warning both key off, just consumed two different ways. */
function balanceScore(yesProbability: number): number {
  return 1 - Math.abs(yesProbability - 0.5) * 2;
}

function simplicityScore(configFieldCount: number): number {
  return 1 - Math.min(configFieldCount, 3) * 0.2;
}

export type RelationshipToActivePools = "NONE" | "DUPLICATE_FAMILY" | "MIRROR_EXISTS" | "EXACT_DUPLICATE";

const RELATIONSHIP_PENALTY: Record<RelationshipToActivePools, number> = {
  NONE: 0,
  DUPLICATE_FAMILY: 0.3,
  MIRROR_EXISTS: 0.6,
  EXACT_DUPLICATE: 1,
};

/** The single strongest relationship this candidate has to any already-
 * active pool on the fixture — not additive across multiple active pools,
 * since what matters for guidance is "how bad is the worst overlap," not a
 * running total. */
export function relationshipToActivePools(
  candidate: QuestionCandidate,
  activePools: ActivePoolSummary[],
): RelationshipToActivePools {
  let strongest: RelationshipToActivePools = "NONE";
  const candidateFamily = getQuestionFamily(candidate.templateId);

  for (const pool of activePools) {
    const otherId = pool.templateId ?? pool.poolType;
    const other: QuestionCandidate = { templateId: otherId, config: pool.templateConfig ?? {} };

    if (isExactDuplicate(candidate, other)) {
      return "EXACT_DUPLICATE"; // can't get any stronger — short-circuit
    }
    if (areMirrors(candidate, other)) {
      strongest = "MIRROR_EXISTS";
      continue;
    }
    if (strongest !== "MIRROR_EXISTS" && candidateFamily !== null && getQuestionFamily(otherId) === candidateFamily) {
      strongest = "DUPLICATE_FAMILY";
    }
  }

  return strongest;
}

export type PublishWarningCode =
  | "EXACT_DUPLICATE"
  | "MIRROR_EXISTS"
  | "DUPLICATE_FAMILY"
  | "POOR_BALANCE"
  | "VERY_UNBALANCED";

export interface PublishWarning {
  code: PublishWarningCode;
  message: string;
}

const WARNING_MESSAGE: Record<Exclude<PublishWarningCode, "POOR_BALANCE" | "VERY_UNBALANCED">, string> = {
  EXACT_DUPLICATE: "Existing equivalent pool — this exact question is already active on this fixture.",
  MIRROR_EXISTS: "Already covered by an equivalent market.",
  DUPLICATE_FAMILY: "Duplicate family — another active pool on this fixture asks a closely related question. Likely liquidity split.",
};

/** Every warning that applies to publishing `candidate` on this fixture
 * right now — never used to silently block; the caller decides whether to
 * require an explicit override. */
export function detectConflicts(
  candidate: QuestionCandidate,
  activePools: ActivePoolSummary[],
  yesProbability: number,
): PublishWarning[] {
  const warnings: PublishWarning[] = [];
  const relationship = relationshipToActivePools(candidate, activePools);

  if (relationship === "EXACT_DUPLICATE") {
    warnings.push({ code: "EXACT_DUPLICATE", message: WARNING_MESSAGE.EXACT_DUPLICATE });
  } else if (relationship === "MIRROR_EXISTS") {
    warnings.push({ code: "MIRROR_EXISTS", message: WARNING_MESSAGE.MIRROR_EXISTS });
  } else if (relationship === "DUPLICATE_FAMILY") {
    warnings.push({ code: "DUPLICATE_FAMILY", message: WARNING_MESSAGE.DUPLICATE_FAMILY });
  }

  if (yesProbability < 0.15 || yesProbability > 0.85) {
    warnings.push({ code: "VERY_UNBALANCED", message: "Very unbalanced — one side is overwhelmingly likely." });
  } else if (yesProbability < 0.3 || yesProbability > 0.7) {
    warnings.push({ code: "POOR_BALANCE", message: "Poor balance — the outcome is fairly predictable." });
  }

  return warnings;
}

export interface TemplateRecommendation {
  template: PoolTemplate<Record<string, unknown>>;
  config: Record<string, unknown>;
  yesProbability: number;
  stars: 1 | 2 | 3 | 4 | 5;
  gradingReliability: GradingReliability;
  warnings: PublishWarning[];
  reasons: string[];
  // Where yesProbability came from — surfaced in the admin UI as "Market
  // estimate" vs. a plain heuristic. bookmakerCount/oddsLine/marketKey/
  // oddsUpdatedAt are only ever non-null (or non-zero) when
  // probabilitySource isn't STATIC_PRIOR.
  probabilitySource: ProbabilityEstimateSource;
  bookmakerCount: number;
  oddsLine: number | null;
  marketKey: string | null;
  oddsUpdatedAt: string | null;
}

function starsFromScore(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 0.8) return 5;
  if (score >= 0.6) return 4;
  if (score >= 0.4) return 3;
  if (score >= 0.2) return 2;
  return 1;
}

function buildReasons(
  yesProbability: number,
  gradingReliability: GradingReliability,
  configFieldCount: number,
): string[] {
  const reasons: string[] = [];
  const balance = balanceScore(yesProbability);
  if (balance >= 0.8) reasons.push(`Well balanced — estimated ${Math.round(yesProbability * 100)}% YES`);
  if (gradingReliability === "AUTO") reasons.push("Auto-graded from the final score, no live match data needed");
  if (configFieldCount === 0) reasons.push("Simple, no configuration required");
  return reasons;
}

/** Default config for a template's required fields, so every registry
 * template can be scored even before an admin has configured it — team-side
 * fields default to HOME (arbitrary but consistent; scoring never depends
 * on which side is "correct", only on the shape of the question). */
export function defaultConfigFor(template: PoolTemplate<Record<string, unknown>>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of template.requiredConfigFields) {
    if (field.type === "TEAM_SIDE") config[field.key] = "HOME";
    else if (field.type === "INTEGER") config[field.key] = field.min;
    else if (field.type === "HALF_POINT_LINE") config[field.key] = field.min;
    else if (field.type === "BOOLEAN") config[field.key] = false;
    // PLAYER fields are left unset — no fixture-independent default exists.
  }
  return config;
}

/** Scores one template (with the given config, or its own default config
 * if omitted) against a fixture's currently active pools. When `markets`
 * carries real fixture odds and the template is odds-allowlisted, the
 * question's threshold (for line-based templates) and yesProbability come
 * from bookmaker consensus instead of the static prior — see
 * estimateYesProbabilityWithSource. */
export function scoreTemplate(
  template: PoolTemplate<Record<string, unknown>>,
  activePools: ActivePoolSummary[],
  config: Record<string, unknown> = defaultConfigFor(template),
  markets: NormalizedFixtureMarkets | null = null,
): TemplateRecommendation {
  const estimate = estimateYesProbabilityWithSource(template.id, config, markets);
  const yesProbability = estimate.probability;
  // The market's own chosen threshold (e.g. minimumGoals) overrides the
  // field-default config so the generated question reflects real odds,
  // not an arbitrary starting value.
  const resolvedConfig = estimate.resolvedConfig ? { ...config, ...estimate.resolvedConfig } : config;
  const gradingReliability = gradingReliabilityOf(template);
  const warnings = detectConflicts({ templateId: template.id, config: resolvedConfig }, activePools, yesProbability);

  const baseScore =
    balanceScore(yesProbability) * 0.5 +
    simplicityScore(template.requiredConfigFields.length) * 0.2 +
    SETTLEMENT_CONFIDENCE_SCORE[gradingReliability] * 0.3;

  const relationship = relationshipToActivePools({ templateId: template.id, config: resolvedConfig }, activePools);
  const finalScore = Math.max(0, baseScore - RELATIONSHIP_PENALTY[relationship]);

  return {
    template,
    config: resolvedConfig,
    yesProbability,
    stars: starsFromScore(finalScore),
    gradingReliability,
    warnings,
    reasons: buildReasons(yesProbability, gradingReliability, template.requiredConfigFields.length),
    probabilitySource: estimate.source,
    bookmakerCount: estimate.bookmakerCount,
    oddsLine: estimate.oddsLine,
    marketKey: estimate.marketKey,
    oddsUpdatedAt: estimate.source === "STATIC_PRIOR" ? null : (markets?.providerUpdatedAt ?? null),
  };
}

export interface RankedRecommendations {
  recommended: TemplateRecommendation[];
  other: TemplateRecommendation[];
}

// TemplateRecommendation.template carries the full PoolTemplate object,
// including its questionBuilder/availabilityCheck/gradingRule functions —
// fine for server-side use, but functions can't cross the Server Action
// boundary back to a Client Component (Next.js throws at serialization
// time). getFixtureQuestionContextAction returns this plain-data shape
// instead; the client re-resolves the real template locally via
// getLatestTemplate(templateId), which is itself a pure, client-safe
// function already used throughout the wizard.
export type SerializableRecommendation = Omit<TemplateRecommendation, "template"> & { templateId: string };

export interface RankedRecommendationsSerializable {
  recommended: SerializableRecommendation[];
  other: SerializableRecommendation[];
}

export function toSerializableRecommendation(rec: TemplateRecommendation): SerializableRecommendation {
  const { template, ...rest } = rec;
  return { ...rest, templateId: template.id };
}

// Player-scoped templates need a real player picked before they can be
// meaningfully scored/configured (no fixture-independent default exists) —
// excluded from ranking entirely, same as the existing wizard already
// treats PLAYER fields as requiring a live fixture roster.
const RECOMMENDABLE_CATEGORIES = new Set(["MATCH_RESULT", "GOALS", "DISCIPLINE"]);

// INTEGER (e.g. minimumGoals) and HALF_POINT_LINE (e.g. a spread/total)
// fields both name a specific NUMBER the recommendation has to pick — that
// number is only ever legitimate when it comes from a real bookmaker line
// for this exact fixture (ODDS_ALLOWLIST_TEMPLATE_IDS + markets actually
// available and cleared the consensus bar; see estimateYesProbabilityWithSource).
// Absent that, defaultConfigFor's fallback (the field's bare minimum) is a
// fabricated placeholder, not a real value — recommending it anyway, dressed
// up with a star rating and a percentage, would look like vetted analysis
// and isn't. A super admin must never be steered into treating a guessed
// number as data. TEAM_SIDE/BOOLEAN fields don't have this problem (no
// number is being invented — "which of the two known teams" or "on/off"
// aren't guesses the same way a threshold is), so they're unaffected.
//
// This is fixture-specific, not template-specific: MATCH_TOTAL_GOALS is
// odds-allowlisted, so it's a real recommendation whenever this fixture
// actually has live market data, and correctly withheld otherwise — same
// template, different fixtures, different outcomes. WINNING_MARGIN and
// every NFL line template (SPREAD/GAME_TOTAL/TEAM_TOTAL) have no real-odds
// path at all yet (see odds-mapping.ts's ODDS_ALLOWLIST_TEMPLATE_IDS
// comment, and lib/pools/templates/nfl.ts respectively), so their
// probabilitySource is always STATIC_PRIOR and they're always excluded
// here — still browsable manually, never auto-recommended.
const THRESHOLD_FIELD_TYPES = new Set(["INTEGER", "HALF_POINT_LINE"]);
function hasThresholdField(template: PoolTemplate<Record<string, unknown>>): boolean {
  return template.requiredConfigFields.some((f) => THRESHOLD_FIELD_TYPES.has(f.type));
}
function isDataBackedRecommendation(rec: TemplateRecommendation): boolean {
  return !hasThresholdField(rec.template) || rec.probabilitySource !== "STATIC_PRIOR";
}

const RECOMMENDED_LIMIT = 5;

/** Whichever of two scored candidates for the same template is closer to a
 * 50/50 split — used to pick between a TEAM_SCOPED template's HOME and AWAY
 * variants without ever structurally preferring one side. */
function betterBalanced(a: TemplateRecommendation, b: TemplateRecommendation): TemplateRecommendation {
  return Math.abs(a.yesProbability - 0.5) <= Math.abs(b.yesProbability - 0.5) ? a : b;
}

/** Scores one template for a fixture. TEAM_SCOPED templates (Clean Sheet,
 * Team total goals, ...) score both the HOME and AWAY variant and keep
 * only whichever is better balanced — the previous version of this
 * function always defaulted to HOME, which meant the away side was never
 * even considered as a candidate. */
function scoreCandidate(
  template: PoolTemplate<Record<string, unknown>>,
  activePools: ActivePoolSummary[],
  markets: NormalizedFixtureMarkets | null,
): TemplateRecommendation {
  if (!TEAM_SCOPED_TEMPLATE_IDS.has(template.id)) {
    return scoreTemplate(template, activePools, defaultConfigFor(template), markets);
  }
  const homeConfig = { ...defaultConfigFor(template), team: "HOME" };
  const awayConfig = { ...defaultConfigFor(template), team: "AWAY" };
  const homeRec = scoreTemplate(template, activePools, homeConfig, markets);
  const awayRec = scoreTemplate(template, activePools, awayConfig, markets);
  return betterBalanced(homeRec, awayRec);
}

/** Ranks every eligible registry template for a fixture, split into a
 * short "Recommended" list (highest-scoring, no blocking relationship to
 * an existing pool) and everything else. Legacy pool_types (WHO_WILL_
 * ADVANCE/REGULATION_RESULT) and COMBO never appear here — neither has a
 * single well-defined YES probability, and per the product decision to
 * treat them as traditional markets, they're never part of the
 * recommendation ranking, only ever manually browsable.
 *
 * `markets` — real fixture odds, normalized (lib/sports-data/types.ts) and
 * already fetched by the caller (never fetched here; this function stays
 * pure/synchronous). Null when odds aren't available, in which case every
 * candidate falls back to its static prior, identical to this function's
 * behavior before real odds existed.
 *
 * `sport` — every football-era template is written in football-specific
 * language/data assumptions (goals, clean sheets, red cards), so a
 * candidate is only scored/offered when its own `sports` list includes this
 * fixture's sport. Defaults to "football" for every existing caller that
 * predates NFL. */
export function rankRecommendations(
  activePools: ActivePoolSummary[],
  markets: NormalizedFixtureMarkets | null = null,
  sport: string = "football",
): RankedRecommendations {
  const scored = TEMPLATE_REGISTRY.filter((t) => RECOMMENDABLE_CATEGORIES.has(t.category) && t.sports.includes(sport))
    .map((t) => getLatestTemplate(t.id))
    .filter((t): t is PoolTemplate<Record<string, unknown>> => t !== null)
    .map((t) => scoreCandidate(t, activePools, markets))
    .filter(isDataBackedRecommendation);

  scored.sort((a, b) => b.stars - a.stars || b.yesProbability - a.yesProbability);

  const clean = scored.filter((r) => !r.warnings.some((w) => w.code === "EXACT_DUPLICATE" || w.code === "MIRROR_EXISTS"));
  const recommendedIds = new Set(clean.slice(0, RECOMMENDED_LIMIT).map((r) => r.template.id));

  return {
    recommended: scored.filter((r) => recommendedIds.has(r.template.id)),
    other: scored.filter((r) => !recommendedIds.has(r.template.id)),
  };
}
