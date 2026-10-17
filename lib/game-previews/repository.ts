import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GamePreview, GamePreviewCandidate, GamePreviewConfig, GamePreviewInput, GamePreviewSource, GamePreviewWriteOutcome } from "./types";

/** Fails to the shipped defaults only if the settings row cannot be read; the stored row is the source of truth. */
const DEFAULT_CONFIG: GamePreviewConfig = { maxChars: 700, hookMaxChars: 120, leadHours: 48, staleAfterHours: 36, minRefreshIntervalHours: 6 };

export async function getGamePreviewConfig(): Promise<GamePreviewConfig> {
  const { data } = await createAdminClient().from("game_preview_config").select("max_chars, hook_max_chars, lead_hours, stale_after_hours, min_refresh_interval_hours").eq("id", true).maybeSingle();
  if (!data) return DEFAULT_CONFIG;
  return { maxChars: data.max_chars, hookMaxChars: data.hook_max_chars, leadHours: data.lead_hours, staleAfterHours: data.stale_after_hours, minRefreshIntervalHours: data.min_refresh_interval_hours };
}

/**
 * The saved Preview the Post shows. A plain read of stored text: nothing is researched, generated or called at render time. Null when there is no published Preview for the Game (the Post then shows the Game and its conversation
 * without a Preview block — it never disappears or errors because editorial content is not ready).
 */
export async function getGamePreviewForFixture(fixtureId: string): Promise<GamePreview | null> {
  const { data } = await createAdminClient().from("game_previews").select("fixture_id, hook, body, generated_at, checked_at, frozen_at").eq("fixture_id", fixtureId).eq("status", "PUBLISHED").maybeSingle();
  if (!data) return null;
  return { fixtureId: data.fixture_id, hook: data.hook, body: data.body, generatedAt: data.generated_at, checkedAt: data.checked_at, frozenAt: data.frozen_at };
}

export interface GamePreviewAdminRow extends GamePreview {
  id: string;
  status: "PUBLISHED" | "WITHDRAWN";
  generatedBy: string;
  refreshCount: number;
  withdrawnReason: string | null;
  sources: GamePreviewSource[];
}

/** Admin/audit view of the stored Previews for the given Games, with their provenance. */
export async function listGamePreviewsForAdmin(fixtureIds: string[]): Promise<Map<string, GamePreviewAdminRow>> {
  const out = new Map<string, GamePreviewAdminRow>();
  if (fixtureIds.length === 0) return out;
  const admin = createAdminClient();
  const { data: previews } = await admin.from("game_previews").select("id, fixture_id, hook, body, status, generated_by, generated_at, checked_at, refresh_count, frozen_at, withdrawn_reason").in("fixture_id", fixtureIds);
  const ids = (previews ?? []).map((p) => p.id);
  const { data: sources } = ids.length ? await admin.from("game_preview_sources").select("preview_id, position, url, provider, title, published_at, retrieved_at, supports").in("preview_id", ids).order("position") : { data: [] };
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
      sources: (sources ?? []).filter((s) => s.preview_id === p.id).map((s) => ({ url: s.url, provider: s.provider, title: s.title, publishedAt: s.published_at, retrievedAt: s.retrieved_at, supports: s.supports })),
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
    p_sources: input.sources.map((s) => ({ url: s.url, provider: s.provider, title: s.title, published_at: s.publishedAt ?? null, retrieved_at: s.retrievedAt, supports: s.supports ?? null })),
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
