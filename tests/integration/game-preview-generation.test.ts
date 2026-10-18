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
const input = (fixtureId: string, over: Row = {}) => ({ fixtureId, hook: "Zero wins in five.", body: "Tennessee is 0-5 after a 26-3 loss to Houston. Does it end in Indianapolis?", generatedBy: "openai:test-model", reason: "MISSING" as const, sources: [source()], claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", fact_ids: ["f1"], source_urls: ["https://www.espn.com/nfl/game/_/gameId/1"] }], meta: { provider: "openai", model: "test-model", promptVersion: "v1", attempts: 1 }, ...over });
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
const resetConfig = () => setConfig({ max_chars: 700, hook_max_chars: 120, lead_hours: 48, stale_after_hours: 36, min_refresh_interval_hours: 6, generation_enabled: false, provider: "openai", model: "", web_search_enabled: true, verify_with_model: true, max_attempts: 2, max_games_per_run: 3, max_search_calls_per_game: 8, current_fact_max_age_hours: 72 });
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
  it("ships with automatic generation OFF, NO model id, web search on, and a source policy — and nothing in code decides any of it", async () => {
    const c = await getGamePreviewConfig();
    expect(c).toMatchObject({ generationEnabled: false, provider: "openai", model: "", webSearchEnabled: true, verifyWithModel: true, maxAttempts: 2, maxGamesPerRun: 3, maxSearchCallsPerGame: 8, currentFactMaxAgeHours: 72 });
    expect(c.preferredDomains).toEqual(expect.arrayContaining(["nfl.com", "espn.com"]));
    expect(c.blockedDomains).toEqual(expect.arrayContaining(["reddit.com", "x.com"]));
  });

  it("a Super Admin changes them in one audited call: normalised domains, bounded numbers, a known provider; nobody else can", async () => {
    const regular = await seedUser("gg-regular");
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: regular, p_config: { model: "x" } })).error).not.toBeNull();
    const id = await superAdmin();
    const ok = await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { model: " configured-model ", generation_enabled: true, preferred_domains: [" NFL.com ", "", "ESPN.com"], blocked_domains: ["Reddit.com"], max_attempts: 3, current_fact_max_age_hours: 48 } });
    expect(ok.error).toBeNull();
    expect(await getGamePreviewConfig()).toMatchObject({ model: "configured-model", generationEnabled: true, preferredDomains: ["nfl.com", "espn.com"], blockedDomains: ["reddit.com"], maxAttempts: 3, currentFactMaxAgeHours: 48 });
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { provider: "nope" } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { max_attempts: 99 } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { preferred_domains: "not-an-array" } })).error?.message).toMatch(/invalid_domains/);
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { api_key: "sk-secret" } })).error?.message).toMatch(/unknown_setting_api_key/); // credentials are never a setting
    const audit = await admin.from("audit_logs").select("before, after").eq("action", "settings.game_preview_updated").order("created_at", { ascending: false }).limit(1).single();
    expect((audit.data!.before as Row).model).toBe("");
    expect((audit.data!.after as Row).model).toBe("configured-model");
  });
});

describe("claim-level provenance", () => {
  it("stores the claim → fact → source map, the generation metadata and the supporting excerpt with the Preview", async () => {
    const g = await game();
    expect((await saveGamePreview(input(g.fixtureId))).outcome).toBe("created");
    const row = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(row.claims).toEqual([{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", fact_ids: ["f1"], source_urls: ["https://www.espn.com/nfl/game/_/gameId/1"] }]);
    expect(row.generationMeta).toMatchObject({ provider: "openai", model: "test-model", promptVersion: "v1" });
    expect(row.sources[0]).toMatchObject({ excerpt: "Texans 26, Titans 3. Tennessee falls to 0-5.", supports: "Tennessee is 0-5" });
    expect(row.generatedBy).toBe("openai:test-model");
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
  const run = (over: Row = {}) => ({ fixtureId: "", trigger: "ADMIN" as const, reason: "MISSING", status: "SUCCEEDED" as const, provider: "openai", model: "test-model", attempts: 1, searchCalls: 5, modelCalls: 3, inputTokens: 1000, outputTokens: 400, factsFound: 6, error: null, previewId: null, startedAt: new Date().toISOString(), ...over });

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
    expect(s.byProviderModel).toEqual([{ provider: "openai", model: "test-model", runs: 4 }]);
    const recent = await listRecentGenerationRuns(10);
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
    const saved = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      await setConfig({ generation_enabled: true, model: "configured-model" });
      expect(await runGamePreviewAutomation()).toMatchObject({ enabled: true, configured: false, attempted: 0 });
      process.env.OPENAI_API_KEY = "sk-test-not-used";
      await setConfig({ generation_enabled: true, model: "" });
      expect(await runGamePreviewAutomation()).toMatchObject({ enabled: true, configured: false, attempted: 0 });
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
    expect(randomUUID()).toBeTruthy();
  });
});
