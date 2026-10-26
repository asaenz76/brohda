// Brohda 2.1 M3 — parsing of the stored configuration (game_story_config). FAIL CLOSED: a row that is missing or has any invalid value disables generation instead of guessing; the defaults below
// mirror the database defaults and exist only so a disabled config is still a complete object. Auto-publish is a literal `false` in M3 (the database also locks it with a CHECK).
import type { StoryConfig } from "./types";

export const DEFAULT_STORY_CONFIG: StoryConfig = {
  generationEnabled: false,
  autoPublishEnabled: false,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  effort: "medium",
  webSearchToolVersion: "web_search_20250305",
  webSearchEnabled: true,
  maxChars: 300,
  minScore: 80,
  researchWindowHours: 48,
  refreshIntervalMinutes: 360,
  editorialCutoffMinutes: 120,
  maxQueriesPerGame: 6,
  maxSources: 12,
  maxAttempts: 2,
  providerRetries: 1,
  requestTimeoutSeconds: 120,
  maxGamesPerRun: 2,
  maxRunsPerGame: 3,
  statusMaxAgeHours: 48,
  currentFactMaxAgeHours: 168,
  supportedSports: ["american_football", "basketball", "hockey"],
  preferredDomains: [],
  blockedDomains: [],
};

const RANGES = {
  max_chars: [100, 1000], min_score: [0, 100], research_window_hours: [1, 336], refresh_interval_minutes: [15, 10080], editorial_cutoff_minutes: [0, 1440], max_queries_per_game: [0, 30],
  max_sources: [1, 40], max_attempts: [1, 5], provider_retries: [0, 3], request_timeout_seconds: [10, 290], max_games_per_run: [1, 20], max_runs_per_game: [1, 20],
  status_max_age_hours: [1, 720], current_fact_max_age_hours: [1, 8760],
} as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SPORTS = ["american_football", "basketball", "hockey", "baseball"];

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

export function parseStoryConfig(row: unknown): StoryConfig {
  if (!row || typeof row !== "object") return DEFAULT_STORY_CONFIG;
  const r = row as Record<string, unknown>;
  const ints: Record<string, number> = {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = r[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return DEFAULT_STORY_CONFIG;
    ints[key] = v;
  }
  const sports = stringList(r.supported_sports);
  const preferred = stringList(r.preferred_domains);
  const blocked = stringList(r.blocked_domains);
  if (!sports || !preferred || !blocked || !sports.every((s) => SPORTS.includes(s))) return DEFAULT_STORY_CONFIG;
  if (r.provider !== "anthropic" || typeof r.model !== "string" || !r.model.trim() || !EFFORTS.includes(r.effort as never) || typeof r.web_search_tool_version !== "string") return DEFAULT_STORY_CONFIG;
  return {
    generationEnabled: r.generation_enabled === true,
    autoPublishEnabled: false,
    provider: "anthropic",
    model: r.model.trim(),
    effort: r.effort as StoryConfig["effort"],
    webSearchToolVersion: r.web_search_tool_version,
    webSearchEnabled: r.web_search_enabled !== false,
    maxChars: ints.max_chars,
    minScore: ints.min_score,
    researchWindowHours: ints.research_window_hours,
    refreshIntervalMinutes: ints.refresh_interval_minutes,
    editorialCutoffMinutes: ints.editorial_cutoff_minutes,
    maxQueriesPerGame: ints.max_queries_per_game,
    maxSources: ints.max_sources,
    maxAttempts: ints.max_attempts,
    providerRetries: ints.provider_retries,
    requestTimeoutSeconds: ints.request_timeout_seconds,
    maxGamesPerRun: ints.max_games_per_run,
    maxRunsPerGame: ints.max_runs_per_game,
    statusMaxAgeHours: ints.status_max_age_hours,
    currentFactMaxAgeHours: ints.current_fact_max_age_hours,
    supportedSports: sports,
    preferredDomains: preferred.map((d) => d.trim().toLowerCase()).filter(Boolean),
    blockedDomains: blocked.map((d) => d.trim().toLowerCase()).filter(Boolean),
  };
}
