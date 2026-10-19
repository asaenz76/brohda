import type { GamePreviewClaim } from "../types";

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
}

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

export interface ResearchResult {
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
/** Stage 2b: after the story is chosen and before anything is written, independently verify every material fact it needs — the source supports the claim, the date and season are right, no authoritative source disagrees. */
export interface GamePreviewFactVerifierProvider {
  readonly name: string;
  verifyFacts(game: GameIdentity, facts: CandidateFact[], ctx: FactVerificationContext): Promise<FactVerificationResult>;
}

export interface DraftContext extends StageContext {
  maxChars: number;
  hookMaxChars: number;
  /** How many facts the story may cite at most. */
  maxCitedFacts: number;
  /** Why the previous attempt was rejected (empty on the first attempt). */
  feedback: string[];
}
export interface PreviewDraft {
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

export interface VerificationResult {
  /** Every statement is supported by the facts it cites. */
  supported: boolean;
  /** Editorial judgement: the hook stops the scroll, the story is specific, it is one story, it reads like an editor and not game notes. */
  editorialPasses: boolean;
  problems: string[];
  usage: ProviderUsage;
}
/** Optional stage 4: an independent read of the draft against its facts and the editorial bar. Supplemental — the deterministic checks stay authoritative. */
export interface GamePreviewVerifierProvider {
  readonly name: string;
  verify(game: GameIdentity, angle: EditorialAngle, draft: Pick<PreviewDraft, "hook" | "preview" | "claims">, facts: CandidateFact[], ctx: StageContext): Promise<VerificationResult>;
}

export interface GamePreviewProviders {
  research: GamePreviewResearchProvider;
  angles: GamePreviewAngleProvider;
  writer: GamePreviewWriterProvider;
  verifier: GamePreviewVerifierProvider | null;
  /** Independent re-check of the chosen story's facts; null = skipped. */
  factVerifier?: GamePreviewFactVerifierProvider | null;
}
