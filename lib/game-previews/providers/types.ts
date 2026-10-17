import type { GamePreviewClaim } from "../types";

/**
 * Provider-neutral contracts for producing a Game Preview. Research and writing are separate stages with separate interfaces, so the Game / Post domain never depends on one vendor, and a stage can be swapped (or
 * faked in tests) without touching the other. Nothing here knows about OpenAI; `providers/openai.ts` is one implementation, selected by the stored `game_preview_config.provider`.
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

/** `current` = true NOW about a team or player (form, injury, lineup); `historical` = true regardless of when it is read (a past result, a record, a head-to-head). Freshness rules differ. */
export type FactKind = "current" | "historical";

/** One researched, sourced statement of fact about this Game's teams or players. The writer may only use facts; the stored provenance is built from the facts it cites. */
export interface CandidateFact {
  id: string;
  kind: FactKind;
  claim: string;
  /** The passage of the source that supports the claim. */
  excerpt: string | null;
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

export interface ResearchContext {
  model: string;
  maxSearchCalls: number;
  preferredDomains: string[];
  blockedDomains: string[];
}
export interface ResearchResult {
  facts: CandidateFact[];
  usage: ProviderUsage;
}
/** Stage 1: find verified, sourced facts about this exact matchup. Web research is mandatory: an implementation must actually search, and must return only facts whose source it really retrieved. */
export interface GamePreviewResearchProvider {
  readonly name: string;
  research(game: GameIdentity, ctx: ResearchContext): Promise<ResearchResult>;
}

export interface DraftContext {
  model: string;
  maxChars: number;
  hookMaxChars: number;
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
/** Stage 2: choose the most interesting TRUE story among the facts and write the hook and the preview from them — and only from them. */
export interface GamePreviewWriterProvider {
  readonly name: string;
  write(game: GameIdentity, facts: CandidateFact[], ctx: DraftContext): Promise<PreviewDraft>;
}

export interface VerificationResult {
  supported: boolean;
  problems: string[];
  usage: ProviderUsage;
}
/** Optional stage 3: an independent check that every statement in the draft is supported by the facts it cites. */
export interface GamePreviewVerifierProvider {
  readonly name: string;
  verify(game: GameIdentity, draft: Pick<PreviewDraft, "hook" | "preview" | "claims">, facts: CandidateFact[], ctx: { model: string }): Promise<VerificationResult>;
}

export interface GamePreviewProviders {
  research: GamePreviewResearchProvider;
  writer: GamePreviewWriterProvider;
  verifier: GamePreviewVerifierProvider | null;
}
