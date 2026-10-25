import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseStoryConfig } from "./settings";
import type { HistoryFixture } from "./structured-evidence";
import type { EvidenceItem, GameContext, StoryConfig } from "./types";

// Brohda 2.1 M3 — database access for the Game Story Engine. Service-role only: none of these tables has a client policy, and every mutation goes through a security-definer function that enforces the invariants.

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function getStoryConfig(): Promise<StoryConfig> {
  const { data, error } = await createAdminClient().from("game_story_config").select("*").eq("id", true).maybeSingle();
  if (error) throw error;
  return parseStoryConfig(data);
}

export async function loadGameContext(fixtureId: string): Promise<GameContext | null> {
  const admin = createAdminClient();
  const [{ data: f, error }, { data: p }] = await Promise.all([
    admin.from("fixtures").select("id, sport, competition_name, season, home_team_name, away_team_name, home_team_external_id, away_team_external_id, scheduled_start_utc").eq("id", fixtureId).maybeSingle(),
    admin.from("posts").select("id").eq("fixture_id", fixtureId).maybeSingle(),
  ]);
  if (error) throw error;
  if (!f || !p) return null;
  return { fixtureId: f.id, postId: p.id, sport: f.sport, competition: f.competition_name, season: f.season, homeTeam: f.home_team_name, awayTeam: f.away_team_name, kickoffUtc: f.scheduled_start_utc, homeTeamExternalId: f.home_team_external_id, awayTeamExternalId: f.away_team_external_id };
}

/** Every recent fixture either team played (same sport), for the deterministic head-to-head / form / rest facts. Bounded: ~14 months and 250 rows. */
export async function loadTeamHistory(game: GameContext, now: Date): Promise<HistoryFixture[]> {
  const admin = createAdminClient();
  const since = new Date(now.getTime() - 420 * 86_400_000).toISOString();
  const names = [game.homeTeam, game.awayTeam];
  const cols = "id, home_team_name, away_team_name, home_team_external_id, away_team_external_id, scheduled_start_utc, internal_status, home_score, away_score";
  const [home, away] = await Promise.all(
    (["home_team_name", "away_team_name"] as const).map((col) => admin.from("fixtures").select(cols).eq("sport", game.sport).in(col, names).gte("scheduled_start_utc", since).lt("scheduled_start_utc", game.kickoffUtc).order("scheduled_start_utc", { ascending: false }).limit(250)),
  );
  if (home.error) throw home.error;
  if (away.error) throw away.error;
  const rows = new Map<string, HistoryFixture>();
  for (const r of [...(home.data ?? []), ...(away.data ?? [])] as Row[])
    rows.set(r.id, { id: r.id, homeTeam: r.home_team_name, awayTeam: r.away_team_name, homeExternalId: r.home_team_external_id, awayExternalId: r.away_team_external_id, startUtc: r.scheduled_start_utc, status: r.internal_status, homeScore: r.home_score, awayScore: r.away_score });
  return [...rows.values()];
}

/** Hooks of recent stories (any Game), so a new hook can be checked for repetition. */
export async function loadRecentHooks(limit = 20): Promise<string[]> {
  const { data, error } = await createAdminClient().from("game_story_revisions").select("hook").in("status", ["REVIEW_REQUIRED", "APPROVED", "SUPERSEDED"]).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => r.hook as string);
}

export type StartOutcome = "started" | "disabled" | "not_eligible" | "past_cutoff" | "active_run_exists" | "recently_researched" | "run_limit_reached";
export async function startRun(fixtureId: string, trigger: "SCHEDULED" | "ADMIN" | "REGENERATE", adminId: string | null): Promise<{ runId: string | null; outcome: StartOutcome }> {
  const { data, error } = await createAdminClient().rpc("start_game_story_run", { p_fixture_id: fixtureId, p_trigger: trigger, p_admin_id: adminId });
  if (error) throw error;
  const row = (data as Array<{ run_id: string | null; outcome: StartOutcome }>)[0];
  return { runId: row.run_id, outcome: row.outcome };
}

export async function markRunResearching(runId: string): Promise<void> {
  const { error } = await createAdminClient().from("game_story_runs").update({ status: "RESEARCHING", heartbeat_at: new Date().toISOString() }).eq("id", runId).eq("status", "PENDING");
  if (error) throw error;
}

export async function saveRunResult(runId: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await createAdminClient().rpc("save_game_story_run_result", { p_run_id: runId, p_payload: payload });
  if (error) throw error;
  return data as string;
}

/** A clean failure: the run is closed with a category and a short message; the Game, its Market, Picks and comments are untouched. */
export async function failRun(runId: string, category: string, detail: string, elapsedMs: number, usage?: Record<string, number>): Promise<void> {
  const { error } = await createAdminClient()
    .from("game_story_runs")
    .update({ status: "FAILED", completed_at: new Date().toISOString(), error_category: category.slice(0, 60), rejection_detail: detail.slice(0, 1000), elapsed_ms: elapsedMs, ...(usage ?? {}) })
    .eq("id", runId)
    .in("status", ["PENDING", "RESEARCHING", "CANDIDATE_GENERATED"]);
  if (error) throw error;
}

export async function listCandidates(limit: number): Promise<Array<{ fixtureId: string; sport: string; scheduledStart: string; hasStory: boolean }>> {
  const { data, error } = await createAdminClient().rpc("game_story_candidates", { p_limit: limit });
  if (error) throw error;
  return ((data ?? []) as Row[]).map((r) => ({ fixtureId: r.fixture_id, sport: r.sport, scheduledStart: r.scheduled_start_utc, hasStory: r.has_story }));
}

/** The one approved story of a Game, for the Post. Hook and body only — evidence is never exposed. */
export async function getApprovedStoryForFixture(fixtureId: string): Promise<{ revisionId: string; hook: string; body: string } | null> {
  const admin = createAdminClient();
  const { data: post } = await admin.from("posts").select("story_revision_id").eq("fixture_id", fixtureId).maybeSingle();
  if (!post?.story_revision_id) return null;
  const { data: rev } = await admin.from("game_story_revisions").select("id, hook, body, status").eq("id", post.story_revision_id).eq("status", "APPROVED").maybeSingle();
  return rev ? { revisionId: rev.id, hook: rev.hook, body: rev.body } : null;
}

// ---- Admin -------------------------------------------------------------------------------------------------------------------------------------------------
export const approveRevision = (adminId: string, revisionId: string) => createAdminClient().rpc("approve_game_story_revision", { p_admin_id: adminId, p_revision_id: revisionId });
export const rejectRevision = (adminId: string, revisionId: string, reason: string) => createAdminClient().rpc("reject_game_story_revision", { p_admin_id: adminId, p_revision_id: revisionId, p_reason: reason });
export const withdrawStory = (adminId: string, fixtureId: string, reason: string) => createAdminClient().rpc("withdraw_game_story", { p_admin_id: adminId, p_fixture_id: fixtureId, p_reason: reason });
export const editRevision = (adminId: string, revisionId: string, hook: string, body: string) => createAdminClient().rpc("admin_edit_game_story_revision", { p_admin_id: adminId, p_revision_id: revisionId, p_hook: hook, p_body: body });
export const completeReverification = (revisionId: string, claims: unknown[]) => createAdminClient().rpc("complete_game_story_reverification", { p_revision_id: revisionId, p_claims: claims });
export const setStoryConfig = (adminId: string, config: Record<string, unknown>) => createAdminClient().rpc("admin_set_game_story_config", { p_admin_id: adminId, p_config: config });

export async function loadRevision(revisionId: string): Promise<Row | null> {
  const { data, error } = await createAdminClient().from("game_story_revisions").select("*").eq("id", revisionId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadRunEvidence(runId: string): Promise<EvidenceItem[]> {
  const { data, error } = await createAdminClient().from("game_story_evidence").select("*").eq("run_id", runId).order("position");
  if (error) throw error;
  return ((data ?? []) as Row[]).map((e) => ({
    id: e.id, kind: e.source_kind, authority: e.authority, canonicalId: e.canonical_id, url: e.url, publisher: e.publisher, title: e.title, publishedAt: e.published_at, retrievedAt: e.retrieved_at,
    evidenceType: e.evidence_type, factKey: e.fact_key, factValue: e.fact_value, subjectTeam: e.subject_team, factText: e.fact_text, excerpt: e.excerpt, asOf: e.as_of, status: e.status, statusReason: e.status_reason,
  }));
}

export async function getMetrics(days: number): Promise<Row> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await createAdminClient().rpc("game_story_metrics", { p_since: since });
  if (error) throw error;
  return (data ?? {}) as Row;
}

export async function listReviewQueue(): Promise<Row[]> {
  const { data, error } = await createAdminClient().from("game_story_revisions").select("id, fixture_id, run_id, source, status, hook, body, char_count, total_score, requires_verification, created_at").in("status", ["REVIEW_REQUIRED"]).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return data ?? [];
}

export async function listRecentRuns(limit = 40): Promise<Row[]> {
  const { data, error } = await createAdminClient().from("game_story_runs").select("id, fixture_id, trigger_kind, status, decision, rejection_code, candidate_hook, total_score, sources_kept, elapsed_ms, model, started_at, error_category").order("started_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function loadRunDetail(runId: string): Promise<{ run: Row; evidence: Row[]; claims: Row[]; links: Row[]; revisions: Row[] } | null> {
  const admin = createAdminClient();
  const { data: run, error } = await admin.from("game_story_runs").select("*").eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run) return null;
  const [evidence, claims, revisions] = await Promise.all([
    admin.from("game_story_evidence").select("*").eq("run_id", runId).order("position"),
    admin.from("game_story_claims").select("*").eq("run_id", runId).order("position"),
    admin.from("game_story_revisions").select("*").eq("run_id", runId).order("created_at"),
  ]);
  const claimIds = (claims.data ?? []).map((c) => c.id);
  const links = claimIds.length ? await admin.from("game_story_claim_evidence").select("claim_id, evidence_id").in("claim_id", claimIds) : { data: [] as Row[] };
  return { run, evidence: evidence.data ?? [], claims: claims.data ?? [], links: links.data ?? [], revisions: revisions.data ?? [] };
}

/** Upcoming Games in the supported sports with their latest run, for the Admin "research now" list. */
export async function listUpcomingForAdmin(supportedSports: string[], limit = 40): Promise<Row[]> {
  const admin = createAdminClient();
  const { data: fixtures, error } = await admin.from("fixtures").select("id, sport, home_team_name, away_team_name, scheduled_start_utc, posts!inner(id, published_at, story_revision_id)").in("sport", supportedSports).eq("internal_status", "NOT_STARTED").gt("scheduled_start_utc", new Date().toISOString()).not("posts.published_at", "is", null).order("scheduled_start_utc").limit(limit);
  if (error) throw error;
  const ids = (fixtures ?? []).map((f) => f.id);
  const runs = ids.length ? await admin.from("game_story_runs").select("fixture_id, status, decision, rejection_code, total_score, started_at").in("fixture_id", ids).order("started_at", { ascending: false }) : { data: [] as Row[] };
  const latest = new Map<string, Row>();
  for (const r of runs.data ?? []) if (!latest.has(r.fixture_id)) latest.set(r.fixture_id, r);
  return (fixtures ?? []).map((f) => ({ ...f, latestRun: latest.get(f.id) ?? null }));
}
