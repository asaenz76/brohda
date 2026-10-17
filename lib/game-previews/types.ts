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
}

/** Everything that is tunable about Previews lives in one stored row (game_preview_config), never in code. */
export interface GamePreviewConfig {
  maxChars: number;
  hookMaxChars: number;
  leadHours: number;
  staleAfterHours: number;
  minRefreshIntervalHours: number;
}

/** Why a Preview is being written: it is missing, it went stale, a meaningful new verified story appeared, or a correction. The database refuses a refresh that has no valid reason. */
export type GamePreviewReason = "MISSING" | "STALE" | "NEW_STORY" | "CORRECTION";

export interface GamePreviewInput {
  fixtureId: string;
  hook: string;
  body: string;
  /** Who/what wrote it (a model or process identifier) — recorded for audit. */
  generatedBy: string;
  reason: GamePreviewReason;
  sources: Array<{ url: string; provider: string; title: string; publishedAt?: string | null; retrievedAt: string; supports?: string | null }>;
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
