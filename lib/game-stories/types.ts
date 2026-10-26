// Brohda 2.1 M3 — Game Story Engine: shared types.
//
// The pipeline is  Game → retrieve facts/sources → normalise evidence → generate candidate tensions → draft → verify claims → score → accept/reject.
// The model SYNTHESISES evidence; it is never the evidence. Everything a model returns is validated by application code (and the database) before it can matter.

export const STORY_PROMPT_VERSION = "game-story-2026-10-v1";
export const STORY_RESEARCH_VERSION = "game-story-research-2026-10-v1";

export type SourceKind = "STRUCTURED_DATA" | "OFFICIAL_LEAGUE" | "OFFICIAL_TEAM" | "MAJOR_JOURNALISM" | "LOCAL_JOURNALISM" | "OTHER_REPORTING";
export type EvidenceType = "STRUCTURED" | "ARTICLE" | "OFFICIAL_STATEMENT";
export type EvidenceStatus = "USABLE" | "SUPERSEDED" | "CONFLICTED" | "SUSPICIOUS" | "DROPPED";
export type SubjectTeam = "HOME" | "AWAY" | "BOTH" | "NEITHER";

/** One normalised fact with its provenance. Metadata and paraphrase only — never an article copy. */
export interface EvidenceItem {
  id: string;
  kind: SourceKind;
  /** 0–100 from the central source policy. */
  authority: number;
  /** Normalised URL, or an internal id (`brohda:fixtures:…`) for structured data. Together with the fact text it identifies the item. */
  canonicalId: string;
  url: string | null;
  publisher: string;
  title: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  evidenceType: EvidenceType;
  /** Groups items about the same underlying fact (for contradiction handling), e.g. `availability:jayson-tatum`. */
  factKey: string | null;
  /** The normalised value for factKey (e.g. OUT / QUESTIONABLE for availability). */
  factValue: string | null;
  subjectTeam: SubjectTeam;
  /** A paraphrased, self-contained statement of the fact (≤ 600 chars). */
  factText: string;
  /** The minimum passage needed for internal verification (≤ 400 chars). */
  excerpt: string | null;
  /** When the underlying event occurred, if known. */
  asOf: string | null;
  status: EvidenceStatus;
  statusReason: string | null;
}

export const CLAIM_TYPES = ["STAT", "STREAK", "HISTORY", "AVAILABILITY", "QUOTE", "TRANSACTION", "RESULT", "CONTEXT"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
/** Claim types about CURRENT STATE, whose truth changes with the news cycle and so go stale. A RESULT (or HISTORY) is a past event: it cannot become untrue, so it is never "stale" (whether it is still relevant is the editor's judgement, scored). */
export const CURRENT_CLAIM_TYPES: readonly ClaimType[] = ["STAT", "STREAK", "AVAILABILITY", "TRANSACTION"];

export const AVAILABILITY_STATUSES = ["OUT", "DOUBTFUL", "QUESTIONABLE", "PROBABLE", "AVAILABLE", "RETURNING"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export type ClaimVerdict = "PENDING" | "SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED" | "STALE" | "AMBIGUOUS";

/** An atomic factual claim extracted from the candidate story. `text` must be the fact as the story states it. */
export interface DraftClaim {
  id: string;
  text: string;
  type: ClaimType;
  subjectTeam: SubjectTeam | null;
  evidenceIds: string[];
  availabilityStatus: AvailabilityStatus | null;
  quote: { text: string; speaker: string } | null;
}

export interface Draft {
  hook: string;
  body: string;
  claims: DraftClaim[];
}

export const ANGLE_TYPES = [
  "REVENGE", "STREAK_VS_STREAK", "STAR_ABSENCE", "FORMER_TEAM", "PLAYOFF_REMATCH", "HISTORICAL_DOMINANCE", "UNDERDOG_STRENGTH", "COACHING_RIVALRY", "ROOKIE_VS_VETERAN",
  "MILESTONE", "RECENT_FORM", "TACTICAL_MISMATCH", "MUST_WIN", "RECORD_CHASE", "TURNAROUND", "REST_ADVANTAGE", "OTHER",
] as const;
export type AngleType = (typeof ANGLE_TYPES)[number];

/** A candidate tension found in the evidence. It must rest on evidence ids that exist in this run. */
export interface Angle {
  type: AngleType;
  summary: string;
  evidenceIds: string[];
}

/** The five rubric dimensions, as integers within their maximum. The TOTAL is computed by Brohda, never by the model. */
export interface ScoreDimensions {
  relevance: number;
  evidence: number;
  debate: number;
  originality: number;
  freshness: number;
}
export const DIMENSION_MAX: Readonly<ScoreDimensions> = { relevance: 30, evidence: 25, debate: 20, originality: 15, freshness: 10 };

export interface ModelScore {
  dims: Partial<Record<keyof ScoreDimensions, unknown>>;
  /** The model's own judgement that the copy is generic filler (a hint; the code also checks). */
  generic: boolean;
  /** Safety flags the model raised (e.g. "unsafe", "gambling_advice"). Any non-empty list rejects. */
  safetyFlags: string[];
  rationale: string;
}

export interface ModelClaimVerdict {
  claimId: string;
  verdict: "SUPPORTED" | "PARTIAL" | "UNSUPPORTED" | "CONTRADICTED";
  note: string;
}

export interface ProviderUsage {
  modelCalls: number;
  searchCalls: number;
  inputTokens: number;
  outputTokens: number;
}
export const emptyUsage = (): ProviderUsage => ({ modelCalls: 0, searchCalls: 0, inputTokens: 0, outputTokens: 0 });
export const addUsage = (a: ProviderUsage, b: ProviderUsage): ProviderUsage => ({
  modelCalls: a.modelCalls + b.modelCalls,
  searchCalls: a.searchCalls + b.searchCalls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

/** The canonical Game a story is about. All identity comes from our own fixture row — never from a model or a web page. */
export interface GameContext {
  fixtureId: string;
  postId: string;
  sport: string;
  competition: string | null;
  season: string | null;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  homeTeamExternalId: string | null;
  awayTeamExternalId: string | null;
}

/** Effective, validated configuration (parsed from game_story_config, fail-closed). */
export interface StoryConfig {
  generationEnabled: boolean;
  autoPublishEnabled: false;
  provider: "anthropic";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  webSearchToolVersion: string;
  webSearchEnabled: boolean;
  maxChars: number;
  minScore: number;
  researchWindowHours: number;
  refreshIntervalMinutes: number;
  editorialCutoffMinutes: number;
  maxQueriesPerGame: number;
  maxSources: number;
  maxAttempts: number;
  providerRetries: number;
  requestTimeoutSeconds: number;
  maxGamesPerRun: number;
  maxRunsPerGame: number;
  statusMaxAgeHours: number;
  currentFactMaxAgeHours: number;
  supportedSports: string[];
  preferredDomains: string[];
  blockedDomains: string[];
}

export interface ResearchContext {
  config: StoryConfig;
  now: Date;
}

/** What a research provider returns: facts found on pages, WITHOUT any trust decision. Brohda classifies the source, scores its authority and decides what is usable (source-policy.ts, evidence.ts). */
export interface RawEvidence {
  url: string;
  publisher: string | null;
  title: string | null;
  publishedAt: string | null;
  evidenceType: EvidenceType;
  factKey: string | null;
  factValue: string | null;
  subjectTeam: SubjectTeam;
  factText: string;
  excerpt: string | null;
  asOf: string | null;
}
export interface ResearchResult {
  items: RawEvidence[];
  usage: ProviderUsage;
  queriesUsed: number;
}

export interface StoryResearchProvider {
  research(game: GameContext, ctx: ResearchContext): Promise<ResearchResult>;
}
export interface StoryAngleProvider {
  propose(game: GameContext, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ angles: Angle[]; usage: ProviderUsage }>;
}
export interface StoryDraftProvider {
  draft(game: GameContext, angle: Angle, evidence: EvidenceItem[], ctx: ResearchContext & { feedback: string[]; recentHooks: string[] }): Promise<{ draft: Draft; usage: ProviderUsage }>;
  /** Extract the atomic claims of text that already exists (used when an Admin edited the words). */
  extractClaims(game: GameContext, hook: string, body: string, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ claims: DraftClaim[]; usage: ProviderUsage }>;
}
export interface StoryVerifierProvider {
  verifyClaims(game: GameContext, claims: DraftClaim[], evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ verdicts: ModelClaimVerdict[]; usage: ProviderUsage }>;
}
export interface StoryScorerProvider {
  score(game: GameContext, draft: Draft, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ score: ModelScore; usage: ProviderUsage }>;
}

/** Why a candidate (or a whole run) was rejected. Codes are stable: metrics and the Admin screen group by them. */
export type RejectionCode =
  | "NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "NO_STORY"
  | "UNSUPPORTED_CLAIM"
  | "CONTRADICTED_CLAIM"
  | "STALE_EVIDENCE"
  | "IDENTITY_MISMATCH"
  | "UNVERIFIED_QUOTE"
  | "UNCLAIMED_FACT"
  | "OVER_LENGTH"
  | "WRONG_GAME"
  | "GAMBLING_COPY"
  | "EXTRA_PROPOSITION"
  | "UNSAFE_CONTENT"
  | "GENERIC_FILLER"
  | "INVALID_COPY"
  | "INVALID_SCORE"
  | "LOW_SCORE"
  | "ADMIN_REJECTED";

export interface ClaimResult {
  claim: DraftClaim;
  verdict: ClaimVerdict;
  deterministicOk: boolean;
  modelVerdict: string | null;
  note: string;
  code: RejectionCode | null;
}

export interface CandidateAssessment {
  draft: Draft;
  angle: Angle;
  claims: ClaimResult[];
  /** Per-dimension values after Brohda's deterministic caps. null when scoring did not run. */
  dims: ScoreDimensions | null;
  total: number | null;
  capsApplied: string[];
  rejectionCode: RejectionCode | null;
  rejectionDetail: string | null;
  modelRationale: string | null;
}

export type RunDecision = "ACCEPTED" | "REJECTED" | "NO_STORY";

export interface RunOutcome {
  decision: RunDecision;
  rejectionCode: RejectionCode | null;
  rejectionDetail: string | null;
  /** The best candidate assessed (accepted, or the closest rejected one) — what the Admin screen shows. */
  candidate: CandidateAssessment | null;
  candidatesConsidered: CandidateAssessment[];
  evidence: EvidenceItem[];
  usage: ProviderUsage;
  queriesUsed: number;
  details: Record<string, unknown>;
}
