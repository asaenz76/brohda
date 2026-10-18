/** One Game's stored Preview, exactly as the Post shows it: a short hook and a short factual story. Sources are provenance (admin, audit) and are not part of what a Member reads. */
export interface GamePreview {
  fixtureId: string;
  hook: string;
  body: string;
  generatedAt: string;
  checkedAt: string;
  /** Set once the Game has started: the pregame Preview is final and is never rewritten. */
  frozenAt: string | null;
}

export interface GamePreviewSource {
  url: string;
  provider: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
  supports: string | null;
  /** The passage of the source that supports the claim, kept so a claim can be audited without re-reading the page. */
  excerpt: string | null;
}

/** Everything that is tunable about Previews lives in one stored row (game_preview_config), never in code. */
export interface GamePreviewConfig {
  maxChars: number;
  hookMaxChars: number;
  leadHours: number;
  staleAfterHours: number;
  minRefreshIntervalHours: number;
  /** May the scheduled job generate Previews on its own? OFF by default; an admin can always run one explicitly. */
  generationEnabled: boolean;
  provider: string;
  /** The model id. Empty until a Super Admin sets it: generation refuses to run without one (no model id is hard-coded anywhere). */
  model: string;
  webSearchEnabled: boolean;
  verifyWithModel: boolean;
  maxAttempts: number;
  maxGamesPerRun: number;
  maxSearchCallsPerGame: number;
  /** A claim about the CURRENT state of a team or player (form, injury, roster) needs a source published within this many hours; history may come from older sources. */
  currentFactMaxAgeHours: number;
  preferredDomains: string[];
  blockedDomains: string[];
  /** How hard the model works (low | medium | high | xhigh | max). Starts at medium; raise only if real testing shows a need. */
  effort: string;
  /** The vendor's versioned web-search tool name — a stored setting because the API versions its server tools. */
  webSearchToolVersion: string;
  /** One Game, one story: the most facts a single Preview may cite. */
  maxCitedFacts: number;
  /** A candidate story must average at least this (1-5) to be chosen over the season-record fallback. */
  minStoryScore: number;
}

/** Why a Preview is being written: it is missing, it went stale, material new information appeared, or an admin asked. The database refuses a write that has no valid reason, and honours the stale window and the minimum refresh interval. */
export type GamePreviewReason = "MISSING" | "STALE" | "MATERIAL_NEW_INFORMATION" | "MANUAL_ADMIN_REQUEST";

/** A material statement of a Preview and the research facts that support it. */
export interface GamePreviewClaim {
  text: string;
  factIds: string[];
}

export interface GamePreviewInput {
  fixtureId: string;
  hook: string;
  body: string;
  /** Who/what wrote it (a model or process identifier) — recorded for audit. */
  generatedBy: string;
  reason: GamePreviewReason;
  sources: Array<{ url: string; provider: string; title: string; publishedAt?: string | null; retrievedAt: string; supports?: string | null; excerpt?: string | null }>;
  /** Which stored research facts support which statements (empty for a hand-written Preview). */
  claims?: Array<{ text: string; fact_ids: string[]; source_urls?: string[] }>;
  /** Provider, model, prompt version and usage of the generation (omitted for a hand-written Preview). */
  meta?: Record<string, unknown>;
}

export type GamePreviewWriteOutcome =
  | "created"
  | "refreshed"
  | "fixture_not_found"
  | "game_started"
  | "frozen"
  | "invalid_reason"
  | "invalid_text"
  | "hook_too_long"
  | "body_too_long"
  | "invalid_generator"
  | "invalid_sources"
  | "invalid_claims"
  | "invalid_meta"
  | "no_existing_preview"
  | "already_exists"
  | "not_stale"
  | "too_soon";

export interface GamePreviewCandidate {
  fixtureId: string;
  postId: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
  reason: "MISSING" | "STALE";
  lastCheckedAt: string | null;
}
