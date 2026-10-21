/**
 * Game Preview generation support (migration 207): the generation settings (all stored, automation OFF and no model by default), claim-level provenance stored with a Preview, the audited manual edit, per-run usage and its
 * summary, and that the scheduled automation does nothing — and calls nothing external — unless explicitly turned on and configured. Real local Supabase. (The model calls themselves are covered by unit tests with a mocked API.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import { getGamePreviewConfig, getGamePreviewForFixture, getGenerationUsageSummary, listGamePreviewsForAdmin, listRecentGenerationRuns, recordGenerationRun, saveGamePreview } from "@/lib/game-previews/repository";
import { runGamePreviewAutomation } from "@/lib/game-previews/automation";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const source = (over: Row = {}) => ({ url: "https://www.espn.com/nfl/game/_/gameId/1", provider: "ESPN", title: "Texans 26, Titans 3", publishedAt: new Date(Date.now() - 3_600_000).toISOString(), retrievedAt: new Date().toISOString(), supports: "Tennessee is 0-5", excerpt: "Texans 26, Titans 3. Tennessee falls to 0-5.", ...over });
const input = (fixtureId: string, over: Row = {}) => ({ fixtureId, hook: "Zero wins in five.", body: "Tennessee is 0-5 after a 26-3 loss to Houston. Does it end in Indianapolis?", generatedBy: "anthropic:test-model", reason: "MISSING" as const, sources: [source()], claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", fact_ids: ["f1"], source_urls: ["https://www.espn.com/nfl/game/_/gameId/1"] }], meta: { provider: "anthropic", model: "test-model", promptVersion: "v1", attempts: 1 }, ...over });
let staffId: string | null = null;
const superAdmin = async () => {
  if (!staffId) {
    staffId = await seedUser("gg-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
};
const setConfig = async (values: Row) => {
  const { error } = await admin.from("game_preview_config").update(values).eq("id", true);
  if (error) throw error;
};
const resetConfig = () => setConfig({ max_chars: 700, hook_max_chars: 120, lead_hours: 48, stale_after_hours: 36, min_refresh_interval_hours: 6, generation_enabled: false, provider: "anthropic", model: "", web_search_enabled: true, verify_with_model: true, max_attempts: 2, max_games_per_run: 3, max_search_calls_per_game: 3, current_fact_max_age_hours: 72, effort: "medium", web_search_tool_version: "web_search_20250305", max_cited_facts: 4, min_story_score: 3 });
beforeEach(resetConfig);
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
  await resetConfig();
});
const game = async (startsInMinutes = 24 * 60, withPost = true) => {
  const g = await seedGame({ startsInMinutes, homeName: "Indianapolis Colts", awayName: "Tennessee Titans" });
  if (withPost) await admin.from("posts").insert({ fixture_id: g.fixtureId, published_at: new Date().toISOString() });
  return g;
};

describe("generation settings are stored, with safe defaults", () => {
  it("ships with automatic generation OFF, Anthropic as the provider, NO model id, effort medium, 3 searches per Game, web search on, and a source policy — and nothing in code decides any of it", async () => {
    const c = await getGamePreviewConfig();
    expect(c).toMatchObject({ generationEnabled: false, provider: "anthropic", model: "", webSearchEnabled: true, verifyWithModel: true, maxAttempts: 2, maxGamesPerRun: 3, maxSearchCallsPerGame: 3, currentFactMaxAgeHours: 72, effort: "medium", webSearchToolVersion: "web_search_20250305", maxCitedFacts: 4, minStoryScore: 3 });
    expect(c.preferredDomains).toEqual(expect.arrayContaining(["nfl.com", "espn.com"]));
    expect(c.blockedDomains).toEqual(expect.arrayContaining(["reddit.com", "x.com"]));
  });

  it("a Super Admin changes them in one audited call: normalised domains, bounded numbers, a known provider; nobody else can", async () => {
    const regular = await seedUser("gg-regular");
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: regular, p_config: { model: "x" } })).error).not.toBeNull();
    const id = await superAdmin();
    const ok = await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { model: " claude-test ", effort: "high", web_search_tool_version: "web_search_20260209", max_cited_facts: 3, min_story_score: 3.5, max_search_calls_per_game: 5, generation_enabled: true, preferred_domains: [" NFL.com ", "", "ESPN.com"], blocked_domains: ["Reddit.com"], max_attempts: 3, current_fact_max_age_hours: 48 } });
    expect(ok.error).toBeNull();
    expect(await getGamePreviewConfig()).toMatchObject({ model: "claude-test", effort: "high", webSearchToolVersion: "web_search_20260209", maxCitedFacts: 3, minStoryScore: 3.5, maxSearchCallsPerGame: 5, generationEnabled: true, preferredDomains: ["nfl.com", "espn.com"], blockedDomains: ["reddit.com"], maxAttempts: 3, currentFactMaxAgeHours: 48 });
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { provider: "nope" } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { provider: "openai" } })).error).not.toBeNull(); // only implemented providers are selectable
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { effort: "turbo" } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { web_search_tool_version: "web_search_1999" } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { min_story_score: 9 } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { max_cited_facts: 0 } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { max_attempts: 99 } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { preferred_domains: "not-an-array" } })).error?.message).toMatch(/invalid_domains/);
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { api_key: "sk-secret" } })).error?.message).toMatch(/unknown_setting_api_key/); // credentials are never a setting
    const audit = await admin.from("audit_logs").select("before, after").eq("action", "settings.game_preview_updated").order("created_at", { ascending: false }).limit(1).single();
    expect((audit.data!.before as Row).model).toBe("");
    expect((audit.data!.after as Row).model).toBe("claude-test");
  });
});

describe("claim-level provenance", () => {
  it("stores the claim → fact → source map, the generation metadata and the supporting excerpt with the Preview", async () => {
    const g = await game();
    expect((await saveGamePreview(input(g.fixtureId))).outcome).toBe("created");
    const row = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(row.claims).toEqual([{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", fact_ids: ["f1"], source_urls: ["https://www.espn.com/nfl/game/_/gameId/1"] }]);
    expect(row.generationMeta).toMatchObject({ provider: "anthropic", model: "test-model", promptVersion: "v1" });
    expect(row.sources[0]).toMatchObject({ excerpt: "Texans 26, Titans 3. Tennessee falls to 0-5.", supports: "Tennessee is 0-5" });
    expect(row.generatedBy).toBe("anthropic:test-model");
  });

  it("the contract's per-claim evidence is stored with the Preview (claims may carry extra keys)", async () => {
    const g = await game();
    const claims = [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", fact_ids: ["f1"], source_urls: ["https://www.espn.com/nfl/game/_/gameId/1"], evidence: "Texans 26, Titans 3. Tennessee falls to 0-5." }];
    expect((await saveGamePreview(input(g.fixtureId, { claims, meta: { provider: "anthropic", model: "test-model", promptVersion: "v1", attempts: 1, season: "2026", phase: "regular_season", researchedAt: "2026-10-17T20:00:00.000Z" } }))).outcome).toBe("created");
    const row = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(row.claims).toEqual(claims);
    expect(row.generationMeta).toMatchObject({ season: "2026", phase: "regular_season", researchedAt: "2026-10-17T20:00:00.000Z" });
  });

  it("uses the owner's refresh vocabulary and refuses the old names, malformed claims and metadata", async () => {
    const g = await game();
    expect((await saveGamePreview(input(g.fixtureId))).outcome).toBe("created");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "STALE" }))).outcome).toBe("not_stale");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "MATERIAL_NEW_INFORMATION" }))).outcome).toBe("too_soon");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "NEW_STORY" }))).outcome).toBe("invalid_reason");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "MANUAL_ADMIN_REQUEST", hook: "Regenerated by an admin" }))).outcome).toBe("refreshed");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "MANUAL_ADMIN_REQUEST", claims: "nope" as unknown as [] }))).outcome).toBe("invalid_claims");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "MANUAL_ADMIN_REQUEST", meta: [] as unknown as Row }))).outcome).toBe("invalid_meta");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "MANUAL_ADMIN_REQUEST", sources: [source({ excerpt: "x".repeat(1001) })] }))).outcome).toBe("invalid_sources");
    expect((await getGamePreviewForFixture(g.fixtureId))!.hook).toBe("Regenerated by an admin");
  });
});

describe("manual edit by a Super Admin", () => {
  it("changes the text, keeps the sources, keeps the old version, is audited, needs a note and respects the limits", async () => {
    const g = await game();
    await saveGamePreview(input(g.fixtureId));
    const regular = await seedUser("gg-edit-regular");
    expect((await admin.rpc("admin_edit_game_preview", { p_admin_id: regular, p_fixture_id: g.fixtureId, p_hook: "h", p_body: "b", p_note: "n" })).error).not.toBeNull();
    const id = await superAdmin();
    expect((await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "h", p_body: "b", p_note: " " })).error?.message).toMatch(/note_required/);
    expect(((await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "x".repeat(121), p_body: "b", p_note: "n" })).data as Row).outcome).toBe("hook_too_long");
    expect(((await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "h", p_body: "y".repeat(701), p_note: "n" })).data as Row).outcome).toBe("body_too_long");
    const r = await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "Edited hook", p_body: "Edited story about Tennessee at Indianapolis.", p_note: "Tightened the wording" });
    expect((r.data as Row).outcome).toBe("edited");
    const row = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(row).toMatchObject({ hook: "Edited hook", generatedBy: `admin:${id}`, refreshCount: 1 });
    expect(row.sources).toHaveLength(1); // provenance untouched
    expect(row.generationMeta).toMatchObject({ manualEdit: true, editedBy: id });
    const revisions = (await admin.from("game_preview_revisions").select("hook, replaced_reason").eq("preview_id", row.id)).data as Row[];
    expect(revisions).toEqual([{ hook: "Zero wins in five.", replaced_reason: "MANUAL_ADMIN_REQUEST" }]);
    const audit = await admin.from("audit_logs").select("before, after").eq("action", "game_preview.edited").order("created_at", { ascending: false }).limit(1).single();
    expect((audit.data!.before as Row).hook).toBe("Zero wins in five.");
    expect((audit.data!.after as Row).note).toBe("Tightened the wording");
  });

  it("is refused once the Game has started (the pregame Preview is frozen) or when there is no Preview", async () => {
    const id = await superAdmin();
    const g = await game();
    expect(((await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "h", p_body: "b", p_note: "n" })).data as Row).outcome).toBe("not_found");
    await saveGamePreview(input(g.fixtureId));
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() - 60_000).toISOString(), internal_status: "LIVE" });
    expect(((await admin.rpc("admin_edit_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_hook: "h", p_body: "b", p_note: "n" })).data as Row).outcome).toBe("game_started");
    expect((await getGamePreviewForFixture(g.fixtureId))!.hook).toBe("Zero wins in five.");
  });
});

describe("usage observability", () => {
  const run = (over: Row = {}) => ({ fixtureId: "", trigger: "ADMIN" as const, effort: "medium", toolVersion: "web_search_20250305", details: { chosenAngleId: "a1" }, reason: "MISSING", status: "SUCCEEDED" as const, provider: "anthropic", model: "test-model", attempts: 1, searchCalls: 5, modelCalls: 3, inputTokens: 1000, outputTokens: 400, factsFound: 6, error: null, previewId: null, startedAt: new Date().toISOString(), ...over });

  it("records every run and summarises games researched, searches, model calls, successes, failures, regenerations and calls per Preview", async () => {
    const a = await game();
    const b = await game();
    const before = await getGenerationUsageSummary(new Date(Date.now() - 1000));
    expect(before.runs).toBe(0);
    await recordGenerationRun(run({ fixtureId: a.fixtureId }));
    await recordGenerationRun(run({ fixtureId: a.fixtureId, reason: "MANUAL_ADMIN_REQUEST", searchCalls: 3, modelCalls: 3 }));
    await recordGenerationRun(run({ fixtureId: b.fixtureId, status: "FAILED", error: "research_failed: boom", searchCalls: 2, modelCalls: 1, inputTokens: 100, outputTokens: 0 }));
    await recordGenerationRun(run({ fixtureId: b.fixtureId, status: "REJECTED", error: "draft_rejected", searchCalls: 4, modelCalls: 5 }));
    const s = await getGenerationUsageSummary(new Date(Date.now() - 60_000));
    expect(s).toMatchObject({ gamesResearched: 2, runs: 4, succeeded: 2, failed: 1, rejected: 1, regenerations: 1, searchCalls: 14, modelCalls: 12, inputTokens: 3100, outputTokens: 1200 });
    expect(s.avgCallsPerSuccessfulPreview).toBe(7); // (5+3 + 3+3) / 2
    expect(s.byProviderModel).toEqual([{ provider: "anthropic", model: "test-model", runs: 4 }]);
    const recent = await listRecentGenerationRuns(10);
    expect(recent[0]).toMatchObject({ effort: "medium", toolVersion: "web_search_20250305", details: { chosenAngleId: "a1" } }); // what the run decided is kept with it
    expect(recent.find((r) => r.error === "research_failed: boom")).toMatchObject({ status: "FAILED", searchCalls: 2 });
  });

  it("runs are not readable or writable by Members or visitors", async () => {
    const memberId = await seedUser("gg-run-member");
    const { data } = await admin.auth.admin.getUserById(memberId);
    const member = getTestAnonClient();
    expect((await member.auth.signInWithPassword({ email: data.user!.email!, password: "integration-test-password-123" })).error).toBeNull();
    for (const client of [member, getTestAnonClient()]) {
      expect(((await client.from("game_preview_runs").select("*")).data ?? []).length).toBe(0);
      expect((await client.from("game_preview_runs").insert({}).select()).error).not.toBeNull();
      expect((await client.rpc("game_preview_usage_summary", {})).error).not.toBeNull();
    }
  });
});

describe("automatic generation is OFF unless explicitly on and configured", () => {
  it("does nothing by default — no candidates are touched, no run is recorded, nothing external is called", async () => {
    await game(6 * 60);
    const before = await getGenerationUsageSummary(null);
    expect(await runGamePreviewAutomation()).toEqual({ enabled: false, configured: false, attempted: 0, succeeded: 0, failed: 0 });
    expect((await getGenerationUsageSummary(null)).runs).toBe(before.runs);
  });

  it("switched on without credentials or without a model it still does nothing, and says why", async () => {
    await game(6 * 60);
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      await setConfig({ generation_enabled: true, model: "claude-test" });
      expect(await runGamePreviewAutomation()).toMatchObject({ enabled: true, configured: false, attempted: 0 });
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-used";
      await setConfig({ generation_enabled: true, model: "" });
      expect(await runGamePreviewAutomation()).toMatchObject({ enabled: true, configured: false, attempted: 0 });
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    expect(randomUUID()).toBeTruthy();
  });
});

describe("who asked for a manual generation: the acting Admin is recorded and audited (migration 209)", () => {
  const runInput = (fixtureId: string, over: Row = {}) => ({ fixtureId, trigger: "ADMIN" as const, reason: "MISSING", status: "SUCCEEDED" as const, provider: "anthropic", model: "test-model", attempts: 1, searchCalls: 5, modelCalls: 3, inputTokens: 1000, outputTokens: 400, factsFound: 8, error: null, previewId: null, startedAt: new Date(Date.now() - 60_000).toISOString(), effort: "medium", toolVersion: "web_search_20250305", details: {}, ...over });
  const lastRun = async (fixtureId: string) => (await admin.from("game_preview_runs").select("id, actor_id, trigger, status").eq("fixture_id", fixtureId).order("started_at", { ascending: false }).limit(1).single()).data!;
  const auditFor = async (runId: string) => (await admin.from("audit_logs").select("actor_id, action, entity_type, entity_id, after").eq("entity_id", runId).eq("action", "game_preview.generate")).data ?? [];

  it("an ADMIN run records the actor and writes a game_preview.generate audit event tied to the Game and the run", async () => {
    const actor = await superAdmin();
    const g = await game();
    await recordGenerationRun(runInput(g.fixtureId, { actorId: actor }));
    const row = await lastRun(g.fixtureId);
    expect(row).toMatchObject({ actor_id: actor, trigger: "ADMIN" });
    const events = await auditFor(row.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: actor, entity_type: "game_preview_runs", entity_id: row.id });
    expect(events[0].after).toMatchObject({ fixture_id: g.fixtureId, run_id: row.id, trigger: "ADMIN", status: "SUCCEEDED" });
  });

  it("the audit event carries the result of a failed run too", async () => {
    const actor = await superAdmin();
    const g = await game();
    await recordGenerationRun(runInput(g.fixtureId, { actorId: actor, status: "REJECTED", error: "no_trusted_primary_source" }));
    const row = await lastRun(g.fixtureId);
    expect((await auditFor(row.id))[0].after).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
  });

  it("an ADMIN run without an actor (older callers) stays unattributed and writes no audit event: unknown is never guessed", async () => {
    const g = await game();
    await recordGenerationRun(runInput(g.fixtureId));
    const row = await lastRun(g.fixtureId);
    expect(row.actor_id).toBeNull();
    expect(await auditFor(row.id)).toHaveLength(0);
  });

  it("an AUTOMATIC run never carries a human actor, even if one is passed", async () => {
    const actor = await superAdmin();
    const g = await game();
    await recordGenerationRun(runInput(g.fixtureId, { trigger: "AUTOMATIC", actorId: actor }));
    const row = await lastRun(g.fixtureId);
    expect(row).toMatchObject({ actor_id: null, trigger: "AUTOMATIC" });
    expect(await auditFor(row.id)).toHaveLength(0);
    // And the database itself refuses the combination.
    const { error } = await admin.from("game_preview_runs").insert({ fixture_id: g.fixtureId, trigger: "AUTOMATIC", reason: "MISSING", status: "FAILED", provider: "anthropic", model: "m", actor_id: actor });
    expect(error?.message ?? "").toMatch(/game_preview_runs_actor_only_admin|violates check/);
  });

  it("a user who is not a Super Admin cannot be recorded as the actor", async () => {
    const player = await seedUser("gg-player");
    const g = await game();
    await expect(recordGenerationRun(runInput(g.fixtureId, { actorId: player }))).rejects.toThrow(/actor_not_admin/);
    expect((await admin.from("game_preview_runs").select("id").eq("fixture_id", g.fixtureId)).data).toHaveLength(0);
  });
});

describe("the latest completed Games of each team before a fixture (freshness cutoff)", () => {
  const seed = async (over: Row) => {
    const { data, error } = await admin.from("fixtures").insert({ provider: "api_nfl", external_fixture_id: `fresh-${randomUUID()}`, sport: "american_football", competition_external_id: "1", season: "2026", home_team_name: "Seed Home", away_team_name: "Seed Away", home_team_external_id: "100", away_team_external_id: "200", internal_status: "COMPLETED", ...over }).select("id").single();
    if (error) throw error;
    return data!.id as string;
  };
  const at = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
  const target = (over: Row = {}) => ({ provider: "api_nfl", competition_external_id: "1", season: "2026", scheduled_start_utc: at(3), home_team_name: "Seed Home", away_team_name: "Seed Away", home_team_external_id: "100", away_team_external_id: "200", ...over });

  it("returns each team's own most recent COMPLETED earlier Game (start + 3h), and ignores later, unfinished, other-season and other-competition Games", async () => {
    const { latestCompletedGames } = await import("@/lib/game-previews/completed-games");
    const older = at(-10), recent = at(-2), awayLatest = at(-5);
    await seed({ scheduled_start_utc: older, home_team_external_id: "100", away_team_external_id: "300", home_team_name: "Seed Home", away_team_name: "Other A" });
    await seed({ scheduled_start_utc: recent, home_team_external_id: "400", away_team_external_id: "100", home_team_name: "Other B", away_team_name: "Seed Home" }); // Seed Home's latest
    await seed({ scheduled_start_utc: awayLatest, home_team_external_id: "200", away_team_external_id: "500", home_team_name: "Seed Away", away_team_name: "Other C" }); // Seed Away's latest
    await seed({ scheduled_start_utc: at(-1), internal_status: "NOT_STARTED" }); // not completed
    await seed({ scheduled_start_utc: at(-1), season: "2025" }); // another season
    await seed({ scheduled_start_utc: at(-1), competition_external_id: "9" }); // another competition
    await seed({ scheduled_start_utc: at(5) }); // after the fixture
    const out = await latestCompletedGames(target());
    expect(out.map((x) => x.team).sort()).toEqual(["Seed Away", "Seed Home"]);
    expect(out.find((x) => x.team === "Seed Home")!.completedUtc).toBe(new Date(new Date(recent).getTime() + 3 * 3_600_000).toISOString());
    expect(out.find((x) => x.team === "Seed Away")!.completedUtc).toBe(new Date(new Date(awayLatest).getTime() + 3 * 3_600_000).toISOString());
  });

  it("an opener (no earlier completed Game for either team) returns nothing: known none, not unknown", async () => {
    const { latestCompletedGames } = await import("@/lib/game-previews/completed-games");
    expect(await latestCompletedGames(target({ home_team_external_id: "901", away_team_external_id: "902", home_team_name: "New A", away_team_name: "New B" }))).toEqual([]);
  });
});
