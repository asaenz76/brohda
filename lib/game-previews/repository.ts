import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { derivePublicSources } from "./public-sources";
import type { GamePreview, GamePreviewCandidate, GamePreviewConfig, GamePreviewInput, GamePreviewSource, GamePreviewWriteOutcome } from "./types";

/** Used only if the settings row cannot be read at all; the stored row is the source of truth. Generation stays OFF and unconfigured in that case. */
const DEFAULT_CONFIG: GamePreviewConfig = {
  maxChars: 700, hookMaxChars: 120, leadHours: 48, staleAfterHours: 36, minRefreshIntervalHours: 6,
  generationEnabled: false, provider: "openai", model: "", webSearchEnabled: true, verifyWithModel: true,
  maxAttempts: 2, maxGamesPerRun: 3, maxSearchCallsPerGame: 3, currentFactMaxAgeHours: 72, preferredDomains: [], blockedDomains: [],
  effort: "medium", webSearchToolVersion: "web_search_20250305", maxCitedFacts: 4, minStoryScore: 3,
  automationCompetitions: ["NFL", "NBA", "NHL"], automationRetryHours: 24, automationTechnicalRetryHours: 6, statusRefreshEnabled: true, statusRefreshWindowHours: 24,
};

const CONFIG_COLUMNS =
  "max_chars, hook_max_chars, lead_hours, stale_after_hours, min_refresh_interval_hours, generation_enabled, provider, model, web_search_enabled, verify_with_model, max_attempts, max_games_per_run, max_search_calls_per_game, current_fact_max_age_hours, preferred_domains, blocked_domains, effort, web_search_tool_version, max_cited_facts, min_story_score, automation_competitions, automation_retry_hours, automation_technical_retry_hours, status_refresh_enabled, status_refresh_window_hours";

export async function getGamePreviewConfig(): Promise<GamePreviewConfig> {
  const { data } = await createAdminClient().from("game_preview_config").select(CONFIG_COLUMNS).eq("id", true).maybeSingle();
  if (!data) return DEFAULT_CONFIG;
  return {
    maxChars: data.max_chars,
    hookMaxChars: data.hook_max_chars,
    leadHours: data.lead_hours,
    staleAfterHours: data.stale_after_hours,
    minRefreshIntervalHours: data.min_refresh_interval_hours,
    generationEnabled: data.generation_enabled,
    provider: data.provider,
    model: data.model,
    webSearchEnabled: data.web_search_enabled,
    verifyWithModel: data.verify_with_model,
    maxAttempts: data.max_attempts,
    maxGamesPerRun: data.max_games_per_run,
    maxSearchCallsPerGame: data.max_search_calls_per_game,
    currentFactMaxAgeHours: data.current_fact_max_age_hours,
    preferredDomains: data.preferred_domains ?? [],
    blockedDomains: data.blocked_domains ?? [],
    effort: data.effort,
    webSearchToolVersion: data.web_search_tool_version,
    maxCitedFacts: data.max_cited_facts,
    minStoryScore: Number(data.min_story_score),
    automationCompetitions: data.automation_competitions ?? ["NFL", "NBA", "NHL"],
    automationRetryHours: data.automation_retry_hours ?? 24,
    automationTechnicalRetryHours: data.automation_technical_retry_hours ?? 6,
    statusRefreshEnabled: data.status_refresh_enabled ?? true,
    statusRefreshWindowHours: data.status_refresh_window_hours ?? 24,
  };
}

/**
 * The saved Preview the Post shows. A plain read of stored text: nothing is researched, generated or called at render time. Null when there is no published Preview for the Game (the Post then shows the Game and its conversation
 * without a Preview block — it never disappears or errors because editorial content is not ready).
 */
/**
 * The CANONICAL stored state of a Game's Preview, for Admin decisions: it does not go through the public getter, which hides a Preview whose public credit is not eligible. Public visibility and existence are separate questions.
 * `status` is the stored row's status (null: no row); `visible` is whether Members can see it.
 */
export interface GamePreviewAdminState {
  exists: boolean;
  status: "PUBLISHED" | "WITHDRAWN" | null;
  visible: boolean;
}
export async function getGamePreviewAdminState(fixtureId: string): Promise<GamePreviewAdminState> {
  const { data } = await createAdminClient().from("game_previews").select("status").eq("fixture_id", fixtureId).maybeSingle();
  if (!data) return { exists: false, status: null, visible: false };
  const status = data.status as "PUBLISHED" | "WITHDRAWN";
  const visible = status === "PUBLISHED" ? (await getGamePreviewForFixture(fixtureId)) !== null : false;
  return { exists: true, status, visible };
}

/**
 * The write reason an Admin Generate / Regenerate must use for the stored state (the database rules: MISSING only when no row or a withdrawn one exists, anything else needs a PUBLISHED row): no Preview or a withdrawn one -> MISSING;
 * a published one, visible or hidden -> MANUAL_ADMIN_REQUEST (the normal canonical regeneration path; never a duplicate insert).
 */
export function adminGenerationReason(state: Pick<GamePreviewAdminState, "status">): "MISSING" | "MANUAL_ADMIN_REQUEST" {
  return state.status === "PUBLISHED" ? "MANUAL_ADMIN_REQUEST" : "MISSING";
}

export async function getGamePreviewForFixture(fixtureId: string): Promise<GamePreview | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("game_previews").select("id, fixture_id, hook, body, generated_at, checked_at, frozen_at, generation_meta").eq("fixture_id", fixtureId).eq("status", "PUBLISHED").maybeSingle();
  if (!data) return null;
  const { data: rows } = await admin.from("game_preview_sources").select("url, provider, title, published_at").eq("preview_id", data.id).order("position").limit(8);
  const sources = derivePublicSources((rows ?? []).map((r) => ({ url: r.url, provider: r.provider, title: r.title, publishedAt: r.published_at })), data.generation_meta as Record<string, unknown> | null);
  // No published Game Preview without a visible supporting source: one that cannot credit its reporting is not shown.
  if (sources.length === 0) return null;
  return { fixtureId: data.fixture_id, hook: data.hook, body: data.body, generatedAt: data.generated_at, checkedAt: data.checked_at, frozenAt: data.frozen_at, sources };
}

/** The hooks of the most recent Previews (published or withdrawn), newest first: the writer varies its structure from them. */
export async function listRecentHooks(limit = 12): Promise<string[]> {
  const { data } = await createAdminClient().from("game_previews").select("hook").order("generated_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => r.hook);
}

export interface GamePreviewAdminRow extends Omit<GamePreview, "sources"> {
  id: string;
  status: "PUBLISHED" | "WITHDRAWN";
  generatedBy: string;
  refreshCount: number;
  withdrawnReason: string | null;
  claims: Array<{ text: string; fact_ids: string[] }>;
  generationMeta: Record<string, unknown>;
  sources: GamePreviewSource[];
}

/** Admin/audit view of the stored Previews for the given Games, with their provenance. */
export async function listGamePreviewsForAdmin(fixtureIds: string[]): Promise<Map<string, GamePreviewAdminRow>> {
  const out = new Map<string, GamePreviewAdminRow>();
  if (fixtureIds.length === 0) return out;
  const admin = createAdminClient();
  const { data: previews } = await admin.from("game_previews").select("id, fixture_id, hook, body, status, generated_by, generated_at, checked_at, refresh_count, frozen_at, withdrawn_reason, claims, generation_meta").in("fixture_id", fixtureIds);
  const ids = (previews ?? []).map((p) => p.id);
  const { data: sources } = ids.length ? await admin.from("game_preview_sources").select("preview_id, position, url, provider, title, published_at, retrieved_at, supports, excerpt").in("preview_id", ids).order("position") : { data: [] };
  for (const p of previews ?? []) {
    out.set(p.fixture_id, {
      id: p.id,
      fixtureId: p.fixture_id,
      hook: p.hook,
      body: p.body,
      status: p.status as "PUBLISHED" | "WITHDRAWN",
      generatedBy: p.generated_by,
      generatedAt: p.generated_at,
      checkedAt: p.checked_at,
      refreshCount: p.refresh_count,
      frozenAt: p.frozen_at,
      withdrawnReason: p.withdrawn_reason,
      claims: p.claims ?? [],
      generationMeta: p.generation_meta ?? {},
      sources: (sources ?? []).filter((s) => s.preview_id === p.id).map((s) => ({ url: s.url, provider: s.provider, title: s.title, publishedAt: s.published_at, retrievedAt: s.retrieved_at, supports: s.supports, excerpt: s.excerpt })),
    });
  }
  return out;
}

export async function listGamePreviewCandidates(): Promise<GamePreviewCandidate[]> {
  const { data, error } = await createAdminClient().rpc("game_preview_candidates");
  if (error) throw error;
  type Row = { fixture_id: string; post_id: string; home_team_name: string; away_team_name: string; competition_name: string | null; scheduled_start_utc: string; reason: string; last_checked_at: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    fixtureId: r.fixture_id,
    postId: r.post_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    competitionName: r.competition_name,
    scheduledStartUtc: r.scheduled_start_utc,
    reason: r.reason as "MISSING" | "STALE",
    lastCheckedAt: r.last_checked_at,
  }));
}

/** The one way a Preview is written (validated again, authoritatively, inside the database function). */
export async function saveGamePreview(input: GamePreviewInput): Promise<{ outcome: GamePreviewWriteOutcome; previewId?: string }> {
  const { data, error } = await createAdminClient().rpc("upsert_game_preview", {
    p_fixture_id: input.fixtureId,
    p_hook: input.hook,
    p_body: input.body,
    p_generated_by: input.generatedBy,
    p_reason: input.reason,
    p_sources: input.sources.map((s) => ({ url: s.url, provider: s.provider, title: s.title, published_at: s.publishedAt ?? null, retrieved_at: s.retrievedAt, supports: s.supports ?? null, excerpt: s.excerpt ?? null })),
    p_claims: input.claims ?? [],
    p_meta: input.meta ?? {},
  });
  if (error) throw error;
  return data as { outcome: GamePreviewWriteOutcome; previewId?: string };
}

export interface UpcomingGameRow {
  fixtureId: string;
  postId: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
}

/** Published, unstarted Games starting within the next `days` days, soonest first (the admin page's list). */
export async function listUpcomingGamesForAdmin(days: number, limit = 60): Promise<UpcomingGameRow[]> {
  const now = Date.now();
  const { data } = await createAdminClient()
    .from("posts")
    .select("id, fixture_id, fixtures!inner(home_team_name, away_team_name, competition_name, scheduled_start_utc, internal_status)")
    .not("published_at", "is", null)
    .eq("fixtures.internal_status", "NOT_STARTED")
    .gt("fixtures.scheduled_start_utc", new Date(now).toISOString())
    .lte("fixtures.scheduled_start_utc", new Date(now + days * 86_400_000).toISOString())
    .limit(Math.max(limit * 4, 200));
  type Row = { id: string; fixture_id: string; fixtures: { home_team_name: string; away_team_name: string; competition_name: string | null; scheduled_start_utc: string } | null };
  return ((data ?? []) as unknown as Row[])
    .filter((r): r is Row & { fixtures: NonNullable<Row["fixtures"]> } => r.fixtures !== null)
    .map((r) => ({ fixtureId: r.fixture_id, postId: r.id, homeTeamName: r.fixtures.home_team_name, awayTeamName: r.fixtures.away_team_name, competitionName: r.fixtures.competition_name, scheduledStartUtc: r.fixtures.scheduled_start_utc }))
    .sort((a, b) => a.scheduledStartUtc.localeCompare(b.scheduledStartUtc))
    .slice(0, limit);
}

/** Published Previews of Games that have already started (newest first): their Game has no row in the upcoming list, but a Preview found to break the editorial contract must still be withdrawable. */
export async function listStartedGamePreviewsForAdmin(limit = 30): Promise<Array<UpcomingGameRow & { preview: GamePreviewAdminRow }>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("posts")
    .select("id, fixture_id, fixtures!inner(home_team_name, away_team_name, competition_name, scheduled_start_utc)")
    .not("published_at", "is", null)
    .lte("fixtures.scheduled_start_utc", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(400);
  type Row = { id: string; fixture_id: string; fixtures: { home_team_name: string; away_team_name: string; competition_name: string | null; scheduled_start_utc: string } | null };
  const games = ((data ?? []) as unknown as Row[]).filter((r): r is Row & { fixtures: NonNullable<Row["fixtures"]> } => r.fixtures !== null);
  const previews = await listGamePreviewsForAdmin(games.map((g) => g.fixture_id));
  return games
    .filter((g) => previews.get(g.fixture_id)?.status === "PUBLISHED")
    .map((g) => ({ fixtureId: g.fixture_id, postId: g.id, homeTeamName: g.fixtures.home_team_name, awayTeamName: g.fixtures.away_team_name, competitionName: g.fixtures.competition_name, scheduledStartUtc: g.fixtures.scheduled_start_utc, preview: previews.get(g.fixture_id)! }))
    .sort((a, b) => b.scheduledStartUtc.localeCompare(a.scheduledStartUtc))
    .slice(0, limit);
}

export interface GenerationRunInput {
  fixtureId: string;
  trigger: "AUTOMATIC" | "ADMIN";
  reason: string;
  status: "SUCCEEDED" | "FAILED" | "REJECTED";
  provider: string;
  model: string;
  attempts: number;
  searchCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  factsFound: number;
  error: string | null;
  previewId: string | null;
  startedAt: string;
  effort?: string;
  toolVersion?: string;
  /** What the run found and decided: sources, facts, angles, rejections. */
  details?: Record<string, unknown>;
  /** The authenticated Admin who asked for an ADMIN run; null for AUTOMATIC runs (and for runs recorded before attribution existed). */
  actorId?: string | null;
}

/** One row per automated or admin-triggered attempt: what it cost and how it ended, so usage and quality are observable from the first run. */
export async function recordGenerationRun(run: GenerationRunInput): Promise<string | void> {
  const { data, error } = await createAdminClient().from("game_preview_runs").insert({
    fixture_id: run.fixtureId, trigger: run.trigger, reason: run.reason, status: run.status, provider: run.provider, model: run.model, attempts: run.attempts, search_calls: run.searchCalls, model_calls: run.modelCalls,
    input_tokens: run.inputTokens, output_tokens: run.outputTokens, facts_found: run.factsFound, error: run.error ? run.error.slice(0, 1000) : null, preview_id: run.previewId, started_at: run.startedAt, effort: run.effort ?? null, tool_version: run.toolVersion ?? null, details: run.details ?? {},
    actor_id: run.trigger === "ADMIN" ? (run.actorId ?? null) : null,
  }).select("id").single();
  if (error) throw error;
  return (data as { id: string } | null)?.id;
}

export interface GenerationUsageSummary {
  since: string | null;
  gamesResearched: number;
  runs: number;
  succeeded: number;
  failed: number;
  rejected: number;
  regenerations: number;
  searchCalls: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  avgCallsPerSuccessfulPreview: number | null;
  byProviderModel: Array<{ provider: string; model: string; runs: number }>;
}

export async function getGenerationUsageSummary(since: Date | null = null): Promise<GenerationUsageSummary> {
  const { data, error } = await createAdminClient().rpc("game_preview_usage_summary", { p_since: since ? since.toISOString() : null });
  if (error) throw error;
  return data as GenerationUsageSummary;
}

export interface GenerationRunRow {
  id: string;
  fixtureId: string;
  trigger: string;
  reason: string;
  status: string;
  model: string;
  searchCalls: number;
  modelCalls: number;
  error: string | null;
  startedAt: string;
  effort: string | null;
  toolVersion: string | null;
  details: Record<string, unknown>;
}

export async function listRecentGenerationRuns(limit = 10): Promise<GenerationRunRow[]> {
  const { data } = await createAdminClient().from("game_preview_runs").select("id, fixture_id, trigger, reason, status, model, search_calls, model_calls, error, started_at, effort, tool_version, details").order("started_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => ({ id: r.id, fixtureId: r.fixture_id, trigger: r.trigger, reason: r.reason, status: r.status, model: r.model, searchCalls: r.search_calls, modelCalls: r.model_calls, error: r.error, startedAt: r.started_at, effort: r.effort, toolVersion: r.tool_version, details: r.details ?? {} }));
}

/** One Game inside the generation lead window and what the scheduler may do with it. `skipReason` null = a candidate; otherwise why the scheduler leaves it alone (see game_preview_automation_candidates). */
export interface AutomationCandidate {
  fixtureId: string;
  postId: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  scheduledStartUtc: string;
  /** INITIAL: no Preview (or one automation itself hid). REFRESH: a status-bearing Preview that may have gone stale. */
  kind: "INITIAL" | "REFRESH";
  reason: "MISSING" | "MATERIAL_NEW_INFORMATION";
  skipReason: string | null;
}

export async function listAutomationCandidates(fixtureId: string | null = null): Promise<AutomationCandidate[]> {
  const { data, error } = await createAdminClient().rpc("game_preview_automation_candidates", { p_fixture_id: fixtureId });
  if (error) throw error;
  type Row = { fixture_id: string; post_id: string; home_team_name: string; away_team_name: string; competition_name: string | null; scheduled_start_utc: string; kind: string; reason: string; skip_reason: string | null };
  return ((data ?? []) as Row[]).map((r) => ({
    fixtureId: r.fixture_id,
    postId: r.post_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    competitionName: r.competition_name,
    scheduledStartUtc: r.scheduled_start_utc,
    kind: r.kind as AutomationCandidate["kind"],
    reason: r.reason as AutomationCandidate["reason"],
    skipReason: r.skip_reason,
  }));
}

/** Withdraw (never delete) a status-bearing Preview whose status could not be re-established. Audited with no human actor. */
export async function hideGamePreviewForAutomation(fixtureId: string, reason: string): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc("automation_hide_game_preview", { p_fixture_id: fixtureId, p_reason: reason });
  if (error) throw error;
  return (data as { outcome?: string } | null)?.outcome === "hidden";
}

export interface AutomationUsageReport {
  since: string;
  attempted: number;
  ready: number;
  needsReview: number;
  failed: number;
  initialRuns: number;
  refreshRuns: number;
  searchCalls: number;
  modelCalls: number;
  parseRecoveries: number;
  statusBlocks: number;
  staleCurrentBlocks: number;
  statusClaimsRemoved: number;
  creditLookupRuns: number;
}

/** The first-week monitoring numbers for AUTOMATIC runs since a moment, derived from the run records. */
export async function getAutomationUsageReport(since: Date | { days: number }): Promise<AutomationUsageReport> {
  const from = since instanceof Date ? since : new Date(Date.now() - since.days * 86_400_000);
  const { data, error } = await createAdminClient().rpc("game_preview_automation_report", { p_since: from.toISOString() });
  if (error) throw error;
  return data as AutomationUsageReport;
}

export interface AutomationJobRun {
  startedAt: string;
  status: string;
  durationMs: number;
  /** The scheduler invocation's own report (Games considered, eligible, selected, results, usage, halted reason). */
  result: Record<string, unknown> | null;
  error: string | null;
}

/** The latest invocations of the scheduled job (one row per invocation in background_jobs, the existing cron run history). */
export async function listAutomationJobRuns(limit = 8): Promise<AutomationJobRun[]> {
  const { data } = await createAdminClient().from("background_jobs").select("started_at, status, duration_ms, result, error").eq("job_name", "game-previews").order("started_at", { ascending: false }).limit(limit);
  return (data ?? []).map((r) => ({ startedAt: r.started_at, status: r.status, durationMs: r.duration_ms, result: (r.result as Record<string, unknown> | null) ?? null, error: r.error }));
}
