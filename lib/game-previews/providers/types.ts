import type { GamePreviewClaim } from "../types";
import type { CompetitionPhase } from "../identity";

/**
 * Provider-neutral contracts for producing a Game Preview. Research, editorial angle selection, writing and verification are separate stages with separate interfaces, so the Game / Post domain never depends on one vendor,
 * and a stage can be swapped (or faked in tests) without touching the others. Nothing here knows about any vendor's request or response shapes; `providers/anthropic.ts` is the V1 implementation, selected by the stored
 * `game_preview_config.provider` through `providers/index.ts`.
 *
 * The editorial rule these stages serve: find the most interesting TRUE story around this specific matchup, then use only the facts that story needs. A Preview is a story hook, not a miniature game-notes page.
 */

/** The canonical identity of the Game a Preview is for. Research is tied to this, not to a free-text query. */
export interface GameIdentity {
  fixtureId: string;
  sport: string;
  competition: string | null;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  /** The season identifier the platform stores for this Game ("2026", "2026-2027"). Never inferred from the calendar year. */
  season: string | null;
  /** preseason, regular season or playoffs, from the provider's round label. */
  phase: CompetitionPhase;
  /** The venue's timezone when known, so the scheduled start can be stated in local time. */
  timezone: string | null;
  /** The most recent COMPLETED Game of each team before this one (null: none yet, an opener). A current-state number must include these Games to be current. */
  lastCompleted?: Array<{ team: string; completedUtc: string }>;
  /** "Now" for the run: the research must be about the time before this Game, as of this instant. */
  asOf: string;
}

/** `current` = true NOW about a team or player and able to change before the game (injury, return, availability, expected starter); `historical` = a completed event or what follows from one (a result, score, record, streak, standing after a game, head-to-head, a milestone already reached). Freshness rules differ. */
export type FactKind = "current" | "historical";

/**
 * Which season a fact belongs to. CURRENT_SEASON = this season's record, standing, streak, form, injury, availability, trend or milestone, and this season's meetings between the teams. HISTORICAL_CONTEXT = anything from an earlier season or
 * a long-run frame (head-to-head history, rivalry, prior playoff meetings, franchise records, historical streaks, "first time since", unusual facts). A previous season is never current form: it is framed as history, and the primary story prefers CURRENT_SEASON material.
 */
export type SeasonScope = "CURRENT_SEASON" | "HISTORICAL_CONTEXT";

/** What kind of page a fact came from: it decides what the page's identity can establish (a current-season statistics page, standings page, game log or schedule from a major provider places a figure in the current season; an undated biography, archive article, prospect profile or historical page cannot). */
export const FACT_SOURCE_TYPES = ["stats_page", "standings", "game_log", "schedule_results", "recap", "article", "injury_report", "preview", "official_release", "profile", "archive", "reference", "other"] as const;
export type FactSourceType = (typeof FACT_SOURCE_TYPES)[number];

/** One researched, sourced statement of fact about this Game's teams or players. The writer may only use facts; the stored provenance is built from the facts it cites. */
export interface CandidateFact {
  id: string;
  kind: FactKind;
  seasonScope: SeasonScope;
  /** What sort of fact it is (streak, milestone, head_to_head, player_form, injury, record, result, ...): lets the editorial stage tell a story from a statistic. */
  category: string;
  claim: string;
  /** The passage of the source that supports the claim — with the surrounding context needed to understand it, not a bare fragment. */
  excerpt: string | null;
  sourceType: FactSourceType;
  /** What the page IS, in a phrase ("ESPN Avalanche team statistics page, current regular season"): the identity that can establish season and team when the sentence itself does not repeat them. */
  pageContext: string | null;
  /** The season the PAGE identifies (its title, header or selected season), e.g. "2026-27"; null when it identifies none. */
  pageSeason: string | null;
  /** The team of the player or coach the fact names, as the page itself shows it; null when the fact names no person. */
  subjectTeam: string | null;
  sourceUrl: string;
  sourceProvider: string;
  sourceTitle: string;
  publishedAt: string | null;
  retrievedAt: string;
  /** 0..1: how interesting and relevant this fact is for a preview of THIS matchup. */
  relevance: number;
  /** How the fact ties to this exact Game (a team, a player on it, the series between them). */
  gameAssociation: string;
  /** Research's own flags for the exceptions that call for extra verification: the page is ambiguous about season, date or team; the claim is unusually surprising or consequential; trusted sources disagree about it. */
  ambiguous: boolean;
  surprising: boolean;
  disputed: boolean;
  /** What kind of figure the fact carries, classified by research: CURRENT_STATE (a season record, average, total, rank, streak or "so far" count that changes with each Game), FIXED (a number about a completed, specific event or period: a score, last season's total, "entering the season", a founding year) or NONE. Unclassified = no freshness gate. */
  numberKind?: NumberKind;
  /** The date the figure is current THROUGH, when the page says ("through five games", "as of Oct. 5"); null when only the page date is known. */
  asOf?: string | null;
  /** The page's own words for the scope of the figure ("through 5 games", "entering the season"). */
  asOfLabel?: string | null;
  /** For a story republished on an aggregator (for example Yahoo): who published it originally, as the page states ("Originally appeared on ..."). The evidence URL stays the aggregator's. */
  originalPublisher?: string | null;
  originalUrl?: string | null;
  /** Other evidence for the SAME claim, kept when the claim's public credit moved to a trusted page found by the credit lookup: the original page and its passage stay available to the writer and the reviewer. The lookup enriches provenance; it never replaces the evidence that supported the claim. */
  alsoSupportedBy?: Array<{ url: string; provider: string; title: string; excerpt: string | null; publishedAt: string | null }>;
}
export const NUMBER_KINDS = ["CURRENT_STATE", "FIXED", "NONE"] as const;
export type NumberKind = (typeof NUMBER_KINDS)[number];

export interface ProviderUsage {
  searchCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export const emptyUsage = (): ProviderUsage => ({ searchCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
export const addUsage = (a: ProviderUsage, b: ProviderUsage): ProviderUsage => ({
  searchCalls: a.searchCalls + b.searchCalls,
  modelCalls: a.modelCalls + b.modelCalls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** Everything a provider needs that is configuration, not code. */
export interface StageContext {
  model: string;
  effort: string;
}

export interface ResearchContext extends StageContext {
  maxSearchCalls: number;
  /** The vendor's versioned name for its web-search tool (a stored setting: the API versions its server tools). */
  webSearchToolVersion: string;
  preferredDomains: string[];
  blockedDomains: string[];
}

/** A page the search actually reached, and what the pipeline did with it. */
export interface ReachedSource {
  url: string;
  title: string;
  status: "accepted" | "rejected";
  reason?: string;
}

/** Two authoritative sources that disagree: recorded for review; the disputed figure is not used when the story can be told without it. */
export interface SourceConflict {
  topic: string;
  note: string;
}

/** What research noticed is going on around the Game, before any angle is chosen: hints for the angle stage (never a constraint), tied to facts by id. */
export interface ResearchLead {
  summary: string;
  factIds: string[];
}

/** Research's check of the supplied Game against an official league or team source. A mismatch ends the run as needs_review: the system never silently switches Games. */
export interface GameCheck {
  confirmed: boolean;
  /** The specific conflict (a different date, opponent, season or phase) when not confirmed. */
  conflict: string | null;
}

export interface ResearchResult {
  /** Absent = not reported (treated as confirmed). */
  gameCheck?: GameCheck;
  facts: CandidateFact[];
  conflicts?: SourceConflict[];
  leads?: ResearchLead[];
  /** Every source the search reached, with whether any fact from it was accepted (and why not, if rejected). */
  sources: ReachedSource[];
  usage: ProviderUsage;
}
/** Stage 1: find verified, sourced facts about this exact matchup. Web research is mandatory: an implementation must actually search, and must return only facts whose source it really reached. */
export interface GamePreviewResearchProvider {
  readonly name: string;
  research(game: GameIdentity, ctx: ResearchContext): Promise<ResearchResult>;
}

/**
 * The editorial kinds of story. Internal vocabulary only — never shown to Members. SEASON_RECORD is the fallback: records and standings are context for a stronger story and rarely the story itself.
 */
export const ANGLE_TYPES = [
  "HOT_VS_COLD",
  "STREAK_ON_THE_LINE",
  "PLAYER_ON_FIRE",
  "REVENGE",
  "RECORD_CHASE",
  "HISTORICAL_ODDITY",
  "COMEBACK",
  "COLLAPSE",
  "BREAKOUT_PLAYER",
  "INJURY_RETURN",
  "OLD_TEAM_NEW_TEAM",
  "DOMINANCE",
  "UPSET_THREAT",
  "CONTRAST",
  "UNFINISHED_BUSINESS",
  "RIVALRY",
  "WEIRD_STAT",
  "MILESTONE",
  "COACH_OR_PLAYER_REUNION",
  "MATCHUP_DOMINANCE",
  "SEASON_RECORD",
] as const;
export type AngleType = (typeof ANGLE_TYPES)[number];
/** What an angle rests on, computed from its facts (never from the model's say-so): this season only, this season with historical support, or history alone. */
export type AngleBasis = "CURRENT_SEASON" | "CURRENT_WITH_HISTORY" | "HISTORY_ONLY";

/** Angle types that are the fallback material rather than a story. */
export const FALLBACK_ANGLE_TYPES: readonly AngleType[] = ["SEASON_RECORD"];

export interface AngleScores {
  tension: number;
  surprise: number;
  specificity: number;
  humanInterest: number;
  conversation: number;
  recency: number;
}

export interface EditorialAngle {
  id: string;
  type: AngleType;
  /** One sentence: the story, in plain words. */
  summary: string;
  /** The facts this story needs — the Preview may cite only these. */
  factIds: string[];
  /** The one or two facts that establish the CENTRAL story (a subset of `factIds`). The public primary source is chosen among these: it must be the source that materially supports the primary claim(s), not an incidental one. */
  centralFactIds?: string[];
  /** 1..5 each. */
  scores: AngleScores;
  /** Why this angle is (or is not) worth a Member's time. */
  note: string;
}

export interface AngleSelection {
  angles: EditorialAngle[];
  selectedId: string;
  selectionReason: string;
  rejected: Array<{ id: string; reason: string }>;
  usage: ProviderUsage;
}
/** Stage 2: from the verified facts, propose 3-5 candidate stories, score them, and pick the strongest — before anything is written. */
export interface GamePreviewAngleProvider {
  readonly name: string;
  selectAngle(game: GameIdentity, facts: CandidateFact[], ctx: StageContext, leads?: ResearchLead[]): Promise<AngleSelection>;
}

/** The outcome of independently re-checking one material fact against its source. */
export type FactCheckStatus = "confirmed" | "unsupported" | "disputed";
export interface FactCheck {
  factId: string;
  status: FactCheckStatus;
  /** How it was settled: the evidence captured during research, a targeted verification search, or neither (not settled). */
  basis: "stored_evidence" | "targeted_search" | "none";
  /** The page could not be retrieved during verification — which is not evidence that the claim is false. */
  retrievalFailed: boolean;
  note: string;
  corroboratingUrl: string | null;
}
export interface FactVerificationContext extends StageContext {
  /** Searches left in this generation's ceiling (0 = judge from the retrieved excerpts only). */
  maxSearchCalls: number;
  webSearchToolVersion: string;
  blockedDomains: string[];
}
export interface FactVerificationResult {
  checks: FactCheck[];
  usage: ProviderUsage;
}
/** The trusted domains a credit lookup may search (the stored trusted list). */
export interface CreditLookupContext extends FactVerificationContext {
  trustedDomains: string[];
}
/** A page on a trusted domain that directly states a claim, found for the PUBLIC CREDIT of a story whose central claim first appeared in a lower-trust or republishing source. */
export interface TrustedSourceHit {
  url: string;
  title: string;
  provider: string;
  /** The date the PAGE shows as published, or null. */
  publishedAt: string | null;
  /** The passage of the page that states the claim. */
  excerpt: string;
}
export interface CreditLookupResult {
  found: Array<{ factId: string; hit: TrustedSourceHit | null }>;
  usage: ProviderUsage;
}
/** Stage 2b: after the story is chosen and before anything is written, independently verify every material fact it needs — the source supports the claim, the date and season are right, no authoritative source disagrees. */
export interface GamePreviewFactVerifierProvider {
  readonly name: string;
  verifyFacts(game: GameIdentity, facts: CandidateFact[], ctx: FactVerificationContext): Promise<FactVerificationResult>;
  /** Find, for each fact, a page on a trusted domain that states the same claim, so the story can be credited to a trusted, readable source. Optional: without it a story whose central claim has no trusted source is not published. */
  findTrustedSources?(game: GameIdentity, facts: CandidateFact[], ctx: CreditLookupContext): Promise<CreditLookupResult>;
  /** For current-state numbers that may be stale (a Game was completed after their evidence): look for the CURRENT value through the latest completed Game, preferring official league/team statistics. Optional: without it a stale candidate is removed. */
  refreshNumbers?(game: GameIdentity, facts: CandidateFact[], ctx: FactVerificationContext): Promise<NumberRefreshResult>;
}
export interface NumberRefresh {
  factId: string;
  /** "confirmed": the same value is current through the latest completed Game. "updated": the value changed (`fact` carries the refreshed claim and source). "unavailable": no current evidence found. */
  status: "confirmed" | "updated" | "unavailable";
  note: string;
  fact?: { claim: string; excerpt: string; sourceUrl: string; sourceTitle: string; sourceProvider: string; publishedAt: string | null; asOf: string | null; asOfLabel: string | null };
}
export interface NumberRefreshResult {
  results: NumberRefresh[];
  usage: ProviderUsage;
}

export interface DraftContext extends StageContext {
  /** Title + caption TOGETHER must be fewer than this many characters. */
  maxChars: number;
  /** How many facts the story may cite at most (guidance, not a gate). */
  maxCitedFacts: number;
  /** Hooks of the most recent Previews: the writer varies its structure from them instead of repeating a formula ("Three games. Four goals. Boston, you're next."). */
  recentHooks: string[];
  /** Why the previous attempt was rejected (empty on the first attempt). */
  feedback: string[];
  /** "blocking": the draft was WRONG (fix every problem). "advisory": the draft is factually valid and will be kept unless the rewrite is better — improve the writing using the notes WITHOUT adding, changing or removing any fact. */
  feedbackKind?: "blocking" | "advisory";
}
export interface PreviewDraft {
  /** "ready", or "needs_review" when no supported story can be written (then `reason` says why and the title and caption are empty). */
  status?: "ready" | "needs_review";
  reason?: string | null;
  /** The title (stored as `hook`) and the caption (stored as `body`). */
  hook: string;
  preview: string;
  /** Every material statement and the fact ids that support it. */
  claims: GamePreviewClaim[];
  promptVersion: string;
  usage: ProviderUsage;
}
/** Stage 3: tell the chosen story with the fewest facts it needs, and only those facts. */
export interface GamePreviewWriterProvider {
  readonly name: string;
  write(game: GameIdentity, angle: EditorialAngle, facts: CandidateFact[], ctx: DraftContext): Promise<PreviewDraft>;
}

/** What makes a Preview WRONG or MISLEADING: each one blocks publication. */
export const BLOCKING_CATEGORIES = [
  "unsupported_claim",
  "wrong_figure",
  "wrong_entity",
  "wrong_season",
  "stale_current",
  "source_conflict",
  "wrong_game",
  "wrong_phase",
  "status_overstated",
  "central_source_mismatch",
  "subject_mismatch",
  "not_relevant_now",
  "logical_contradiction",
  "unsupported_causation",
  "misleading_implication",
  "fabricated_quote",
  "betting_language",
] as const;
export type BlockingCategory = (typeof BLOCKING_CATEGORIES)[number];
/** Editorial taste: recorded for product analysis and used for at most one rewrite, never a reason to reject. */
export const ADVISORY_KINDS = ["bland_story", "weak_hook", "game_note_feel", "repetitive_structure", "low_conversation", "wording_tone"] as const;
export type AdvisoryKind = (typeof ADVISORY_KINDS)[number];

/** Things worth a second look that code noticed but cannot judge (a figure no cited fact contains, "this season" on a fact that does not say it). */
export interface DraftHints {
  figures: string[];
  seasonClaims: string[];
  /** The uncertainty words the cited facts carry ("f4: \"unlikely\""): the Preview must not state more certainty than its sources. */
  hedges?: string[];
  /** Current-state numbers the deterministic freshness check flagged (a Game was completed after their evidence), and any that were refreshed. */
  staleNumbers?: string[];
  /** Cited figures that are FIXED to an earlier point or event ("entering the season", "last season", a specific game): they must not be written as the current figure ("already has", "now has"). */
  fixedNumbers?: string[];
}

export interface VerificationResult {
  /** The Preview is wrong or misleading in a way that must not publish: an unsupported claim, a wrong figure, entity or season, a stale current-state fact, a logical or causal misuse of true facts. */
  blocking: Array<{ category: BlockingCategory; problem: string }>;
  /** Editorial taste only ("reads like game notes", "the hook could be sharper"). */
  advisory: Array<{ kind: AdvisoryKind; note: string }>;
  usage: ProviderUsage;
}
/** Optional stage 4: an independent read of the draft against its facts and the editorial bar. Supplemental — the deterministic checks stay authoritative. */
export interface GamePreviewVerifierProvider {
  readonly name: string;
  verify(game: GameIdentity, angle: EditorialAngle, draft: Pick<PreviewDraft, "hook" | "preview" | "claims">, facts: CandidateFact[], ctx: StageContext, hints?: DraftHints): Promise<VerificationResult>;
}

export interface GamePreviewProviders {
  research: GamePreviewResearchProvider;
  angles: GamePreviewAngleProvider;
  writer: GamePreviewWriterProvider;
  verifier: GamePreviewVerifierProvider | null;
  /** Independent re-check of the chosen story's facts; null = skipped. */
  factVerifier?: GamePreviewFactVerifierProvider | null;
}
