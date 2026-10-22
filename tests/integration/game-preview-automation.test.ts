/**
 * Scheduled Game Preview automation (migration 210), real local Supabase: the ONE rule for what the scheduler may run (and why every other Game is skipped), the retry throttle, the status-bearing refresh rules, the Admin precedence (a withdrawal or a hand edit
 * suppresses automation), the audited automatic hide, the per-Game generation lease, and the monitoring numbers. The generation itself is the unchanged pipeline (covered elsewhere); the orchestration is unit-tested in tests/unit/game-previews/scheduler.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedUser } from "./helpers/game-seed";
import { getAutomationUsageReport, hideGamePreviewForAutomation, listAutomationCandidates, saveGamePreview, listGamePreviewsForAdmin } from "@/lib/game-previews/repository";
import { withGameGenerationLock } from "@/lib/game-previews/generation-lock";
import { runGamePreviewAutomation } from "@/lib/game-previews/automation";
import { emptyAutomationReport } from "@/lib/game-previews/scheduler";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const setConfig = async (values: Row) => {
  const { error } = await admin.from("game_preview_config").update(values).eq("id", true);
  if (error) throw error;
};
const resetConfig = () =>
  setConfig({ lead_hours: 48, stale_after_hours: 36, min_refresh_interval_hours: 6, generation_enabled: false, model: "", automation_competitions: ["NFL", "NBA", "NHL"], automation_retry_hours: 24, automation_technical_retry_hours: 6, status_refresh_enabled: true, status_refresh_window_hours: 24 });
beforeEach(resetConfig);
afterEach(resetConfig);

/** A published Game inside the lead window (default 20 h away), of a supported competition. */
const game = async (startsInHours = 20, competition: string | null = "NFL") => {
  const g = await seedGame({ startsInMinutes: Math.round(startsInHours * 60), homeName: "Indianapolis Colts", awayName: "Tennessee Titans" });
  await admin.from("fixtures").update({ competition_name: competition }).eq("id", g.fixtureId);
  await admin.from("posts").insert({ fixture_id: g.fixtureId, published_at: new Date().toISOString() });
  return g;
};
const source = () => ({ url: "https://www.espn.com/nfl/story/_/id/1/qb-update", provider: "ESPN", title: "QB update", publishedAt: ago(2), retrievedAt: new Date().toISOString(), supports: "x", excerpt: "x" });
const preview = async (fixtureId: string, meta: Row = {}) => {
  const saved = await saveGamePreview({ fixtureId, hook: "A hook", body: "A body about the game.", generatedBy: "anthropic:test", reason: "MISSING", sources: [source()], claims: [{ text: "x", fact_ids: ["f1"] }], meta: { provider: "anthropic", ...meta } });
  expect(saved.outcome).toBe("created");
};
const age = async (fixtureId: string, hours: number) => {
  const { error } = await admin.from("game_previews").update({ generated_at: ago(hours), checked_at: ago(hours) }).eq("fixture_id", fixtureId);
  if (error) throw error;
};
const statusMeta = (asOfHoursAgo: number) => ({ status: { hasStatusClaim: true, asOf: ago(asOfHoursAgo), claims: [{ factId: "f4", claim: "QB questionable", sourceUrl: "https://www.espn.com/x", publishedAt: ago(asOfHoursAgo), verifiedNewest: false }] } });
const candidate = async (fixtureId: string) => (await listAutomationCandidates(fixtureId)).find((c) => c.fixtureId === fixtureId);
const run = async (fixtureId: string, status: "REJECTED" | "FAILED" | "SUCCEEDED", hoursAgo: number, over: Row = {}) => {
  const { error } = await admin.from("game_preview_runs").insert({ fixture_id: fixtureId, trigger: "AUTOMATIC", reason: "MISSING", status, provider: "anthropic", model: "m", started_at: ago(hoursAgo), finished_at: ago(hoursAgo), ...over });
  if (error) throw error;
};
let staffId: string | null = null;
const superAdmin = async () => {
  if (!staffId) {
    staffId = await seedUser("ga-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
};
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

describe("initial generation eligibility (one rule, in the database)", () => {
  it("(B) a published, unstarted Game of a supported competition inside the lead window with no Preview is an INITIAL / MISSING candidate", async () => {
    const g = await game();
    expect(await candidate(g.fixtureId)).toMatchObject({ kind: "INITIAL", reason: "MISSING", skipReason: null, competitionName: "NFL" });
  });

  it("(C) a Game outside the configured lead window is not considered at all, and widening the window (the same one setting) makes it a candidate", async () => {
    const g = await game(100);
    expect(await candidate(g.fixtureId)).toBeUndefined();
    await setConfig({ lead_hours: 120 });
    expect(await candidate(g.fixtureId)).toMatchObject({ skipReason: null });
  });

  it("(R) a Game that has started (or whose Post is unpublished) is never a candidate", async () => {
    const started = await seedGame({ startsInMinutes: 60 });
    await admin.from("posts").insert({ fixture_id: started.fixtureId, published_at: new Date().toISOString() });
    await admin.from("fixtures").update({ competition_name: "NFL", scheduled_start_utc: ago(1) }).eq("id", started.fixtureId);
    expect(await candidate(started.fixtureId)).toBeUndefined();
    const live = await game();
    await admin.from("fixtures").update({ internal_status: "LIVE" }).eq("id", live.fixtureId);
    expect(await candidate(live.fixtureId)).toBeUndefined();
    const unpublished = await seedGame({ startsInMinutes: 600 });
    await admin.from("fixtures").update({ competition_name: "NFL" }).eq("id", unpublished.fixtureId);
    expect(await candidate(unpublished.fixtureId)).toBeUndefined();
  });

  it("league filtering is a stored setting: an unsupported competition is reported as skipped, and the owner can narrow automation to one league", async () => {
    const nfl = await game(20, "NFL");
    const nba = await game(20, "NBA");
    const other = await game(20, "MLS");
    expect(await candidate(other.fixtureId)).toMatchObject({ skipReason: "UNSUPPORTED_COMPETITION" });
    await setConfig({ automation_competitions: ["NFL"] });
    expect(await candidate(nfl.fixtureId)).toMatchObject({ skipReason: null });
    expect(await candidate(nba.fixtureId)).toMatchObject({ skipReason: "UNSUPPORTED_COMPETITION" });
  });

  it("(D) a Game that already has a published Preview is not an INITIAL candidate (and, without a status claim, not a refresh candidate either)", async () => {
    const g = await game(20);
    await preview(g.fixtureId, { facts: [{ id: "f1", kind: "historical", category: "result" }] });
    expect((await candidate(g.fixtureId))?.skipReason).toBe("NOT_STATUS_BEARING");
  });
});

describe("retries: needs_review and technical failure are different, and never hammered", () => {
  it("(G) a Game whose last run ended needs_review is throttled for the configured interval (24 h by default, with a small jitter tolerance), then becomes a candidate again", async () => {
    const g = await game();
    await run(g.fixtureId, "REJECTED", 1);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
    await run(g.fixtureId, "REJECTED", 21.5); // an older run does not matter; the newest rejection (1 h ago) still throttles
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
    await admin.from("game_preview_runs").delete().eq("fixture_id", g.fixtureId);
    await run(g.fixtureId, "REJECTED", 23); // yesterday's run, a daily scheduler with jitter: due again
    expect((await candidate(g.fixtureId))?.skipReason).toBeNull();
    await run(g.fixtureId, "REJECTED", 10);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
    await setConfig({ automation_retry_hours: 6 }); // configurable
    expect((await candidate(g.fixtureId))?.skipReason).toBeNull();
  });

  it("(H) a technical FAILURE has its own interval (6 h by default), so an outage is retried sooner than an editorial rejection", async () => {
    const g = await game();
    await run(g.fixtureId, "FAILED", 1);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("TECHNICAL_RETRY_THROTTLED");
    await admin.from("game_preview_runs").delete().eq("fixture_id", g.fixtureId);
    await run(g.fixtureId, "FAILED", 5.8);
    expect((await candidate(g.fixtureId))?.skipReason).toBeNull();
    await run(g.fixtureId, "REJECTED", 2); // a rejection is judged by ITS interval, not the technical one
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
  });

  it("a SUCCEEDED run does not throttle, and Admin runs count too (an Admin who just got needs_review has the Game left alone)", async () => {
    const g = await game();
    await run(g.fixtureId, "SUCCEEDED", 1);
    expect((await candidate(g.fixtureId))?.skipReason).toBeNull();
    await run(g.fixtureId, "REJECTED", 1, { trigger: "ADMIN" });
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
  });
});

describe("status-bearing Previews: refresh only when it can matter, never routinely", () => {
  it("(J) a published, unfrozen Preview that states a current player status, whose Game is within the refresh window and whose status was established longer ago than the stale window, is a REFRESH candidate", async () => {
    const g = await game(20);
    await preview(g.fixtureId, statusMeta(40));
    await age(g.fixtureId, 40);
    expect(await candidate(g.fixtureId)).toMatchObject({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION", skipReason: null });
  });

  it("(K) a status that was established recently is fresh: no refresh, no cost", async () => {
    const g = await game(20);
    await preview(g.fixtureId, statusMeta(3));
    await age(g.fixtureId, 8);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("STATUS_FRESH");
    await age(g.fixtureId, 40);
    await admin.from("game_previews").update({ generation_meta: { provider: "anthropic", ...statusMeta(3) } }).eq("fixture_id", g.fixtureId); // regenerated long ago, but its status was verified 3 h ago
    expect((await candidate(g.fixtureId))?.skipReason).toBe("STATUS_FRESH");
  });

  it("(N) a Preview without a status claim is never refreshed automatically, however old; neither is one whose Game is outside the refresh window", async () => {
    const plain = await game(20);
    await preview(plain.fixtureId, { status: { hasStatusClaim: false, asOf: null, claims: [] } });
    await age(plain.fixtureId, 200);
    expect((await candidate(plain.fixtureId))?.skipReason).toBe("NOT_STATUS_BEARING");
    const early = await game(40);
    await preview(early.fixtureId, statusMeta(60));
    await age(early.fixtureId, 60);
    expect((await candidate(early.fixtureId))?.skipReason).toBe("OUTSIDE_REFRESH_WINDOW");
    await setConfig({ status_refresh_window_hours: 48 }); // configurable
    expect((await candidate(early.fixtureId))?.skipReason).toBeNull();
  });

  it("a Preview made before status provenance existed is judged conservatively: a current injury fact makes it status-bearing, and its generation time is the status time", async () => {
    const g = await game(20);
    await preview(g.fixtureId, { facts: [{ id: "f2", kind: "current", category: "injury", claim: "QB out" }] });
    await age(g.fixtureId, 40);
    expect(await candidate(g.fixtureId)).toMatchObject({ kind: "REFRESH", skipReason: null });
  });

  it("refresh can be switched off, is spaced by the minimum refresh interval, and never touches a frozen or hand-edited Preview", async () => {
    const g = await game(20);
    await preview(g.fixtureId, statusMeta(40));
    await age(g.fixtureId, 40);
    await setConfig({ status_refresh_enabled: false });
    expect((await candidate(g.fixtureId))?.skipReason).toBe("REFRESH_DISABLED");
    await setConfig({ status_refresh_enabled: true });
    await admin.from("game_previews").update({ generated_at: ago(2) }).eq("fixture_id", g.fixtureId);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("REFRESH_TOO_SOON");
    await age(g.fixtureId, 40);
    await admin.from("game_previews").update({ generation_meta: { provider: "anthropic", manualEdit: true, ...statusMeta(40) } }).eq("fixture_id", g.fixtureId);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("ADMIN_EDITED"); // a deliberate Admin edit is never overwritten by automation
    await admin.from("game_previews").update({ generation_meta: { provider: "anthropic", ...statusMeta(40) }, frozen_at: new Date().toISOString() }).eq("fixture_id", g.fixtureId);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("FROZEN");
  });

  it("a refresh that already ended needs_review is throttled like any other run (no hammering a Game that cannot be refreshed)", async () => {
    const g = await game(20);
    await preview(g.fixtureId, statusMeta(40));
    await age(g.fixtureId, 40);
    await run(g.fixtureId, "REJECTED", 1, { reason: "MATERIAL_NEW_INFORMATION" });
    expect((await candidate(g.fixtureId))?.skipReason).toBe("RETRY_THROTTLED");
  });
});

describe("(Q) Admin precedence: a manual withdrawal suppresses automation; automation's own hide does not", () => {
  it("a Preview an Admin withdrew is never regenerated by automation (ADMIN_WITHDRAWN), including every withdrawal made before this migration", async () => {
    const g = await game();
    await preview(g.fixtureId);
    const id = await superAdmin();
    expect((await admin.rpc("admin_withdraw_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_reason: "wrong claim" })).error).toBeNull();
    expect((await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)?.status).toBe("WITHDRAWN");
    expect((await admin.from("game_previews").select("withdrawn_by").eq("fixture_id", g.fixtureId).single()).data?.withdrawn_by).toBe("ADMIN");
    expect(await candidate(g.fixtureId)).toMatchObject({ kind: "INITIAL", skipReason: "ADMIN_WITHDRAWN" });
    // a legacy withdrawal (no withdrawn_by recorded) is treated the same way
    await admin.from("game_previews").update({ withdrawn_by: null }).eq("fixture_id", g.fixtureId);
    expect((await candidate(g.fixtureId))?.skipReason).toBe("ADMIN_WITHDRAWN");
  });

  it("an Admin who explicitly regenerates a withdrawn Preview clears the suppression: the new Preview is an ordinary published one", async () => {
    const g = await game();
    await preview(g.fixtureId);
    const id = await superAdmin();
    await admin.rpc("admin_withdraw_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_reason: "wrong claim" });
    expect((await saveGamePreview({ fixtureId: g.fixtureId, hook: "New", body: "New body.", generatedBy: "anthropic:test", reason: "MISSING", sources: [source()], claims: [{ text: "x", fact_ids: ["f1"] }] })).outcome).toBe("refreshed");
    const row = (await admin.from("game_previews").select("status, withdrawn_by, withdrawn_reason").eq("fixture_id", g.fixtureId).single()).data!;
    expect(row).toMatchObject({ status: "PUBLISHED", withdrawn_by: null, withdrawn_reason: null });
  });

  it("(M) the automatic hide withdraws (never deletes) a published Preview with a reason, is audited with NO human actor, keeps its text and sources, and leaves the Game retry-able by automation", async () => {
    const g = await game();
    await preview(g.fixtureId, statusMeta(40));
    expect(await hideGamePreviewForAutomation(g.fixtureId, "Automatic status refresh could not re-establish the current player status (NEEDS_REVIEW); hidden until it can be regenerated.")).toBe(true);
    const row = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(row).toMatchObject({ status: "WITHDRAWN", hook: "A hook", body: "A body about the game." });
    expect(row.withdrawnReason).toMatch(/could not re-establish the current player status/);
    expect(row.sources).toHaveLength(1);
    expect((await admin.from("game_previews").select("withdrawn_by").eq("fixture_id", g.fixtureId).single()).data?.withdrawn_by).toBe("AUTOMATION");
    const audit = await admin.from("audit_logs").select("actor_id, action, after").eq("action", "game_preview.auto_hidden").order("created_at", { ascending: false }).limit(1).single();
    expect(audit.data).toMatchObject({ actor_id: null, action: "game_preview.auto_hidden" });
    expect(await candidate(g.fixtureId)).toMatchObject({ kind: "INITIAL", skipReason: null }); // not suppressed: a later run may regenerate it
    expect(await hideGamePreviewForAutomation(g.fixtureId, "again")).toBe(false); // nothing left to hide
  });

  it("the hide refuses a frozen Preview, a started Game and a missing Preview, and needs a reason", async () => {
    const g = await game();
    expect(await hideGamePreviewForAutomation(g.fixtureId, "x")).toBe(false); // no Preview
    await preview(g.fixtureId);
    await admin.from("game_previews").update({ frozen_at: new Date().toISOString() }).eq("fixture_id", g.fixtureId);
    expect(await hideGamePreviewForAutomation(g.fixtureId, "x")).toBe(false);
    await expect(hideGamePreviewForAutomation(g.fixtureId, "  ")).rejects.toThrow();
  });
});

describe("(P) one generation per Game at a time: scheduled and Admin runs cannot race", () => {
  it("while one holds the Game's lease, every other attempt is refused; it is released afterwards; leases are per Game", async () => {
    const a = await game();
    const b = await game();
    const outcome = await withGameGenerationLock(a.fixtureId, async () => {
      expect((await withGameGenerationLock(a.fixtureId, async () => "second")).acquired).toBe(false); // an Admin Generate or a second invocation on the same Game
      const other = await withGameGenerationLock(b.fixtureId, async () => "other game");
      expect(other).toEqual({ acquired: true, value: "other game" });
      return "first";
    });
    expect(outcome).toEqual({ acquired: true, value: "first" });
    expect(await withGameGenerationLock(a.fixtureId, async () => "again")).toEqual({ acquired: true, value: "again" });
  });

  it("the lease is released even when the run throws (a failed generation never blocks the Game)", async () => {
    const g = await game();
    await expect(withGameGenerationLock(g.fixtureId, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await withGameGenerationLock(g.fixtureId, async () => 1)).acquired).toBe(true);
  });

  it("overlapping starts: of several simultaneous attempts exactly one gets the lease", async () => {
    const g = await game();
    const results = await Promise.all(Array.from({ length: 5 }, () => withGameGenerationLock(g.fixtureId, async () => new Promise<string>((r) => setTimeout(() => r("ran"), 150)))));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });
});

describe("(A) the kill switch and the first-week report", () => {
  it("generation_enabled=false: the scheduler entry point does nothing at all, even with eligible Games, a configured model and a key", async () => {
    await game();
    const saved = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-never-used";
      await setConfig({ generation_enabled: false, model: "claude-test" });
      const before = (await admin.from("game_preview_runs").select("id", { count: "exact", head: true })).count;
      expect(await runGamePreviewAutomation()).toEqual(emptyAutomationReport());
      expect((await admin.from("game_preview_runs").select("id", { count: "exact", head: true })).count).toBe(before);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("the monitoring report is derived from AUTOMATIC runs: attempted, ready, needs review, failed, refresh vs initial, usage, format retries, status and stale-current blocks, credit lookups", async () => {
    const g = await game();
    const since = new Date(Date.now() - HOUR);
    await run(g.fixtureId, "SUCCEEDED", 0.5, { search_calls: 7, model_calls: 9, details: { parseRecoveries: [{ stage: "research" }], creditLookups: [{ found: "https://x" }] } });
    await run(g.fixtureId, "REJECTED", 0.4, { reason: "MATERIAL_NEW_INFORMATION", search_calls: 8, model_calls: 11, details: { blockingCounts: { reviewerByCategory: { status_source_ineligible: 2, stale_current: 1 } }, statusChecks: [{ outcome: "removed" }, { outcome: "qualified" }] } });
    await run(g.fixtureId, "FAILED", 0.3, { search_calls: 1, model_calls: 2 });
    await run(g.fixtureId, "SUCCEEDED", 0.2, { trigger: "ADMIN" }); // an Admin run is not automation
    expect(await getAutomationUsageReport(since)).toMatchObject({ attempted: 3, ready: 1, needsReview: 1, failed: 1, initialRuns: 2, refreshRuns: 1, searchCalls: 16, modelCalls: 22, parseRecoveries: 1, statusBlocks: 2, staleCurrentBlocks: 1, statusClaimsRemoved: 1, creditLookupRuns: 1 });
  });

  it("the new settings are stored, audited and bounded", async () => {
    const id = await superAdmin();
    const ok = await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { automation_competitions: [" nfl ", "nba"], automation_retry_hours: 12, automation_technical_retry_hours: 3, status_refresh_enabled: false, status_refresh_window_hours: 36 } });
    expect(ok.error).toBeNull();
    const row = (await admin.from("game_preview_config").select("automation_competitions, automation_retry_hours, automation_technical_retry_hours, status_refresh_enabled, status_refresh_window_hours").eq("id", true).single()).data!;
    expect(row).toEqual({ automation_competitions: ["NFL", "NBA"], automation_retry_hours: 12, automation_technical_retry_hours: 3, status_refresh_enabled: false, status_refresh_window_hours: 36 });
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { automation_retry_hours: 0 } })).error).not.toBeNull();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { automation_competitions: "NFL" } })).error?.message).toMatch(/invalid_competitions/);
  });
});
