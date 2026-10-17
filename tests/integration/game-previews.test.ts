/**
 * Game Previews (migration 206): the editorial purpose of the opened Post. Covers what may be written (limits come from stored configuration, provenance is required and complete), when (never after kickoff; refreshes need a reason and
 * respect the stale / minimum-interval rules), what is kept (every replaced Preview), freezing at kickoff, which Games need one, the operator actions (audited), who can touch it (nobody but the service role), and the Post's
 * per-Market sentiment (commit-before-crowd, one Pick one vote, never a fabricated 0%). Real local Supabase.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";
import { getGamePreviewConfig, getGamePreviewForFixture, listGamePreviewCandidates, listGamePreviewsForAdmin, saveGamePreview } from "@/lib/game-previews/repository";
import { runGamePreviewHousekeeping } from "@/lib/game-previews/housekeeping";
import { getGameMarketSentiment } from "@/lib/posts/game-sentiment";
import { listDisplayableMarketsForFixture } from "@/lib/prediction-markets/repository";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const source = (over: Row = {}) => ({ url: "https://www.nhl.com/news/example-preview", provider: "NHL.com", title: "Devils vs. Capitals preview", publishedAt: new Date(Date.now() - 3_600_000).toISOString(), retrievedAt: new Date().toISOString(), supports: "Recent results", ...over });
const input = (fixtureId: string, over: Row = {}) => ({
  fixtureId,
  hook: "Seven goals. Your move, Washington.",
  body: "The Devils crushed the Rangers 7-1. Today, they chase a third straight win against the Capitals. Who takes it?",
  generatedBy: "integration-test",
  reason: "MISSING" as const,
  sources: [source()],
  ...over,
});
const publish = async (fixtureId: string) => {
  const { data, error } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (error) throw error;
  return data!.id as string;
};
async function game(startsInMinutes = 24 * 60, withPost = false) {
  const g = await seedGame({ startsInMinutes, homeName: "Washington Capitals", awayName: "New Jersey Devils", sport: "ice_hockey" });
  const postId = withPost ? await publish(g.fixtureId) : null;
  return { ...g, postId };
}
const setConfig = async (values: Row) => {
  const { error } = await admin.from("game_preview_config").update(values).eq("id", true);
  if (error) throw error;
};
const stale = async (fixtureId: string, hours = 100) => {
  await admin.from("game_previews").update({ checked_at: new Date(Date.now() - hours * 3_600_000).toISOString() }).eq("fixture_id", fixtureId);
};
let staffId: string | null = null;
const superAdmin = async () => {
  if (!staffId) {
    staffId = await seedUser("gp-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
};
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});
beforeEach(async () => {
  await setConfig({ max_chars: 700, hook_max_chars: 120, lead_hours: 48, stale_after_hours: 36, min_refresh_interval_hours: 6 });
});

describe("configuration, not constants", () => {
  it("ships the documented defaults and reads them from the stored row", async () => {
    expect(await getGamePreviewConfig()).toEqual({ maxChars: 700, hookMaxChars: 120, leadHours: 48, staleAfterHours: 36, minRefreshIntervalHours: 6 });
    await setConfig({ max_chars: 300 });
    expect((await getGamePreviewConfig()).maxChars).toBe(300);
  });

  it("only a Super Admin changes it, only known keys within bounds are accepted, and the change is audited", async () => {
    const regular = await seedUser("gp-regular");
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: regular, p_config: { max_chars: 500 } })).error).not.toBeNull();
    const id = await superAdmin();
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { nope: 1 } })).error?.message).toMatch(/unknown_setting_nope/);
    expect((await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { max_chars: 5 } })).error).not.toBeNull(); // below the floor
    const ok = await admin.rpc("admin_set_game_preview_config", { p_admin_id: id, p_config: { max_chars: 500, lead_hours: 24 } });
    expect(ok.error).toBeNull();
    expect((await getGamePreviewConfig()).maxChars).toBe(500);
    const audit = await admin.from("audit_logs").select("before, after").eq("action", "settings.game_preview_updated").order("created_at", { ascending: false }).limit(1).single();
    expect((audit.data!.before as Row).max_chars).toBe(700);
    expect((audit.data!.after as Row).max_chars).toBe(500);
  });
});

describe("writing a Preview", () => {
  it("creates it with its provenance, and the Post reads exactly that saved text", async () => {
    const g = await game();
    const r = await saveGamePreview(input(g.fixtureId, { sources: [source(), source({ url: "https://www.espn.com/nhl/story/_/id/1", provider: "ESPN", title: "Capitals notebook", supports: null })] }));
    expect(r.outcome).toBe("created");
    const read = await getGamePreviewForFixture(g.fixtureId);
    expect(read).toMatchObject({ hook: "Seven goals. Your move, Washington.", frozenAt: null });
    const [row] = [...(await listGamePreviewsForAdmin([g.fixtureId])).values()];
    expect(row.sources.map((s) => s.provider)).toEqual(["NHL.com", "ESPN"]); // order kept
    expect(row.sources[0]).toMatchObject({ url: "https://www.nhl.com/news/example-preview", title: "Devils vs. Capitals preview" });
    expect(row.sources[0].retrievedAt).toBeTruthy();
    expect(row.generatedBy).toBe("integration-test");
  });

  it("refuses text that is empty or longer than the CONFIGURED limits (nothing is padded or truncated)", async () => {
    const g = await game();
    expect((await saveGamePreview(input(g.fixtureId, { hook: "   " }))).outcome).toBe("invalid_text");
    expect((await saveGamePreview(input(g.fixtureId, { body: "" }))).outcome).toBe("invalid_text");
    expect((await saveGamePreview(input(g.fixtureId, { hook: "x".repeat(121) }))).outcome).toBe("hook_too_long");
    expect((await saveGamePreview(input(g.fixtureId, { body: "y".repeat(701) }))).outcome).toBe("body_too_long");
    await setConfig({ max_chars: 150 });
    expect((await saveGamePreview(input(g.fixtureId, { body: "z".repeat(151) }))).outcome).toBe("body_too_long");
    expect((await saveGamePreview(input(g.fixtureId, { body: "z".repeat(150) }))).outcome).toBe("created");
    expect(await getGamePreviewForFixture(g.fixtureId)).not.toBeNull();
  });

  it("refuses a Preview without complete provenance: sources, URL, provider, title and a retrieval time are all required", async () => {
    const g = await game();
    const bad = async (sources: Row[]) => (await saveGamePreview(input(g.fixtureId, { sources }))).outcome;
    expect(await bad([])).toBe("invalid_sources");
    expect(await bad([source({ url: "ftp://x.com/a" })])).toBe("invalid_sources");
    expect(await bad([source({ url: "not a url" })])).toBe("invalid_sources");
    expect(await bad([source({ provider: " " })])).toBe("invalid_sources");
    expect(await bad([source({ title: "" })])).toBe("invalid_sources");
    expect(await bad([source({ retrievedAt: "garbage" })])).toBe("invalid_sources");
    expect(await bad([source({ retrievedAt: new Date(Date.now() + 86_400_000).toISOString() })])).toBe("invalid_sources");
    expect(await bad(Array.from({ length: 13 }, () => source()))).toBe("invalid_sources");
    expect(await getGamePreviewForFixture(g.fixtureId)).toBeNull();
  });

  it("refuses anything for a Game that has started or does not exist — the pregame Preview is never written after kickoff", async () => {
    const started = await game(-5);
    expect((await saveGamePreview(input(started.fixtureId))).outcome).toBe("game_started");
    const live = await game();
    await setFixture(live.fixtureId, { internal_status: "LIVE" });
    expect((await saveGamePreview(input(live.fixtureId))).outcome).toBe("game_started");
    expect((await saveGamePreview(input(randomUUID()))).outcome).toBe("fixture_not_found");
    expect((await saveGamePreview(input((await game()).fixtureId, { reason: "WHENEVER" }))).outcome).toBe("invalid_reason");
    expect((await saveGamePreview(input((await game()).fixtureId, { generatedBy: " " }))).outcome).toBe("invalid_generator");
  });

  it("writes exactly one Preview per Game under concurrent attempts", async () => {
    const g = await game();
    const results = await Promise.all(Array.from({ length: 5 }, () => saveGamePreview(input(g.fixtureId))));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_exists")).toHaveLength(4);
    expect((await admin.from("game_previews").select("id").eq("fixture_id", g.fixtureId)).data).toHaveLength(1);
  });
});

describe("refreshing: only with a reason, never continuously", () => {
  it("MISSING cannot overwrite an existing Preview; STALE needs real staleness; NEW_STORY respects the minimum interval; CORRECTION is always allowed before kickoff", async () => {
    const g = await game();
    expect((await saveGamePreview(input(g.fixtureId, { reason: "STALE" }))).outcome).toBe("no_existing_preview");
    expect((await saveGamePreview(input(g.fixtureId))).outcome).toBe("created");
    expect((await saveGamePreview(input(g.fixtureId))).outcome).toBe("already_exists");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "STALE", hook: "Fresh hook" }))).outcome).toBe("not_stale");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "NEW_STORY", hook: "Newer hook" }))).outcome).toBe("too_soon");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "CORRECTION", hook: "Corrected hook" }))).outcome).toBe("refreshed");
    expect((await getGamePreviewForFixture(g.fixtureId))!.hook).toBe("Corrected hook");

    await stale(g.fixtureId);
    expect((await saveGamePreview(input(g.fixtureId, { reason: "STALE", hook: "Stale refresh" }))).outcome).toBe("refreshed");
    await admin.from("game_previews").update({ generated_at: new Date(Date.now() - 24 * 3_600_000).toISOString() }).eq("fixture_id", g.fixtureId);
    expect((await saveGamePreview(input(g.fixtureId, { reason: "NEW_STORY", hook: "A genuinely new story" }))).outcome).toBe("refreshed");
    const [row] = [...(await listGamePreviewsForAdmin([g.fixtureId])).values()];
    expect(row.refreshCount).toBe(3);
  });

  it("keeps every replaced Preview — text, sources and why — so the history is auditable", async () => {
    const g = await game();
    await saveGamePreview(input(g.fixtureId, { hook: "First hook", sources: [source({ title: "First source" })] }));
    await saveGamePreview(input(g.fixtureId, { reason: "CORRECTION", hook: "Second hook", sources: [source({ title: "Second source" })] }));
    const preview = (await admin.from("game_previews").select("id").eq("fixture_id", g.fixtureId).single()).data!;
    const revisions = (await admin.from("game_preview_revisions").select("*").eq("preview_id", preview.id)).data as Row[];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ hook: "First hook", replaced_reason: "CORRECTION" });
    expect((revisions[0].sources as Row[])[0]).toMatchObject({ title: "First source", provider: "NHL.com" });
    const current = (await listGamePreviewsForAdmin([g.fixtureId])).get(g.fixtureId)!;
    expect(current.sources.map((s) => s.title)).toEqual(["Second source"]); // the old sources are replaced, not accumulated
  });
});

describe("freezing at kickoff", () => {
  it("freezes the pregame Preview when the Game starts; the Post keeps showing it and nothing rewrites it", async () => {
    const g = await game();
    await saveGamePreview(input(g.fixtureId));
    expect(await runGamePreviewHousekeeping()).toMatchObject({ frozen: 0 });
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() - 60_000).toISOString(), internal_status: "LIVE" });
    expect((await runGamePreviewHousekeeping()).frozen).toBe(1);
    expect((await runGamePreviewHousekeeping()).frozen).toBe(0); // once
    const read = await getGamePreviewForFixture(g.fixtureId);
    expect(read?.frozenAt).not.toBeNull();
    expect(read?.hook).toBe("Seven goals. Your move, Washington.");
    expect((await saveGamePreview(input(g.fixtureId, { reason: "CORRECTION", hook: "Rewrite attempt" }))).outcome).toBe("game_started");
    expect((await getGamePreviewForFixture(g.fixtureId))!.hook).toBe("Seven goals. Your move, Washington.");
  });
});

describe("which Games need a Preview", () => {
  it("lists published, unstarted Games inside the configured lead time that have none (or a stale or withdrawn one) — and nothing else", async () => {
    const needs = await game(6 * 60, true);
    const fresh = await game(6 * 60, true);
    await saveGamePreview(input(fresh.fixtureId));
    const staleOne = await game(6 * 60, true);
    await saveGamePreview(input(staleOne.fixtureId));
    await stale(staleOne.fixtureId);
    const far = await game(5 * 24 * 60, true);
    const noPost = await game(6 * 60, false);
    const startedGame = await game(-10, true);
    const unpublished = await game(6 * 60, false);
    await admin.from("posts").insert({ fixture_id: unpublished.fixtureId, published_at: null });
    const withdrawn = await game(6 * 60, true);
    await saveGamePreview(input(withdrawn.fixtureId));
    expect((await admin.rpc("admin_withdraw_game_preview", { p_admin_id: await superAdmin(), p_fixture_id: withdrawn.fixtureId, p_reason: "wrong score" })).error).toBeNull();

    const byFixture = new Map((await listGamePreviewCandidates()).map((c) => [c.fixtureId, c]));
    expect(byFixture.get(needs.fixtureId)?.reason).toBe("MISSING");
    expect(byFixture.get(staleOne.fixtureId)?.reason).toBe("STALE");
    expect(byFixture.get(withdrawn.fixtureId)?.reason).toBe("MISSING");
    for (const excluded of [fresh, far, noPost, startedGame, unpublished]) expect(byFixture.has(excluded.fixtureId)).toBe(false);

    // The lead time is configuration: widen it and the far Game appears.
    await setConfig({ lead_hours: 24 * 7 });
    expect((await listGamePreviewCandidates()).some((c) => c.fixtureId === far.fixtureId)).toBe(true);
    const report = await runGamePreviewHousekeeping();
    expect(report.missing).toBeGreaterThanOrEqual(3);
    expect(report.stale).toBeGreaterThanOrEqual(1);
  });
});

describe("withdrawing a wrong Preview", () => {
  it("is Super Admin only, needs a reason, is audited, hides the Preview from the Post, and a new one can then be written", async () => {
    const g = await game();
    await saveGamePreview(input(g.fixtureId));
    const regular = await seedUser("gp-w-regular");
    expect((await admin.rpc("admin_withdraw_game_preview", { p_admin_id: regular, p_fixture_id: g.fixtureId, p_reason: "x" })).error).not.toBeNull();
    const id = await superAdmin();
    expect((await admin.rpc("admin_withdraw_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_reason: "  " })).error?.message).toMatch(/reason_required/);
    const w = await admin.rpc("admin_withdraw_game_preview", { p_admin_id: id, p_fixture_id: g.fixtureId, p_reason: "Score was wrong" });
    expect((w.data as Row).outcome).toBe("withdrawn");
    expect(await getGamePreviewForFixture(g.fixtureId)).toBeNull();
    const audit = await admin.from("audit_logs").select("after").eq("action", "game_preview.withdrawn").order("created_at", { ascending: false }).limit(1).single();
    expect((audit.data!.after as Row).reason).toBe("Score was wrong");
    expect((await saveGamePreview(input(g.fixtureId, { hook: "Rewritten", reason: "MISSING" }))).outcome).toBe("refreshed");
    expect((await getGamePreviewForFixture(g.fixtureId))!.hook).toBe("Rewritten");
  });
});

describe("who can touch it", () => {
  it("nobody but the service role: no Member, no anonymous visitor reads or writes any Preview table or calls any Preview function", async () => {
    const g = await game();
    await saveGamePreview(input(g.fixtureId));
    const memberId = await seedUser("gp-member");
    const { data } = await admin.auth.admin.getUserById(memberId);
    const member = getTestAnonClient();
    expect((await member.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
    for (const client of [member, getTestAnonClient()]) {
      for (const table of ["game_previews", "game_preview_sources", "game_preview_revisions", "game_preview_config"]) {
        const r = await client.from(table).select("*");
        expect((r.data ?? []).length, table).toBe(0); // RLS with no policy: nothing readable
        const w = await client.from(table).insert({}).select();
        expect(w.error, `${table} insert`).not.toBeNull();
      }
      for (const [fn, args] of [
        ["upsert_game_preview", { p_fixture_id: g.fixtureId, p_hook: "h", p_body: "b", p_generated_by: "x", p_reason: "MISSING", p_sources: [] }],
        ["freeze_started_game_previews", {}],
        ["game_preview_candidates", {}],
        ["admin_set_game_preview_config", { p_admin_id: memberId, p_config: { max_chars: 100 } }],
        ["admin_withdraw_game_preview", { p_admin_id: memberId, p_fixture_id: g.fixtureId, p_reason: "x" }],
      ] as const) {
        expect((await client.rpc(fn, args as Row)).error, fn).not.toBeNull();
      }
    }
  });
});

describe("the Post's Market sentiment", () => {
  async function addMarket(fixtureId: string, template: "TOTAL" | "SPREAD", line: number) {
    const { data: first } = await admin.from("markets").select("provider").eq("fixture_id", fixtureId).limit(1).single();
    const { data, error } = await admin
      .from("markets")
      .insert({
        provider: first!.provider, provider_market_id: `sec_${randomUUID()}`, question: "Secondary", status: "ACTIVE", fixture_id: fixtureId, market_template: template, yes_side: template === "TOTAL" ? null : "HOME", line_value: line,
        yes_price: 0.5, no_price: 0.5, price_outcome_labels: { yes: "yes", no: "no" }, liquidity: 500, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "integration_test", provider_metadata: {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return data!.id as string;
  }
  async function member(label: string) {
    const id = await seedUser(label);
    await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
    return id;
  }
  const compose = async (memberId: string, marketId: string, side: "YES" | "NO", amount = 1) => {
    const r = await admin.rpc("create_confidence_prediction", { p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() });
    expect((r.data as Row).outcome).toBe("created");
  };

  it("shows each Market in the configured order, reveals only the Markets the viewer has finished, never counts Confidence as weight, and never fabricates a split", async () => {
    await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);
    const g = await game();
    const totalId = await addMarket(g.fixtureId, "TOTAL", 6);
    const spreadId = await addMarket(g.fixtureId, "SPREAD", -1.5);
    const a = await member("sent-a");
    const b = await member("sent-b");
    const c = await member("sent-c");
    // Moneyline: a and b pick YES (one with 🔥5, one with 🔥1), c picks NO → 67 / 33. Total: only a picks.
    await compose(a, g.marketId, "YES", 5);
    await compose(b, g.marketId, "YES", 1);
    await compose(c, g.marketId, "NO", 1);
    await compose(a, totalId, "NO", 1);
    const markets = await listDisplayableMarketsForFixture(g.fixtureId);
    const sentiment = await getGameMarketSentiment({ userId: a, sport: "ice_hockey", homeTeamName: "Washington Capitals", awayTeamName: "New Jersey Devils", markets, templatePriority: ["MONEYLINE", "TOTAL", "SPREAD"] });
    expect(sentiment.map((s) => s.marketId)).toEqual([g.marketId, totalId, spreadId]);
    const [ml, tot, spr] = sentiment;
    expect(ml).toMatchObject({ revealed: true, totalPickCount: 3, viewerConfidence: 5, hasViewerPick: true });
    expect(ml.choices.map((x) => x.percent).sort()).toEqual([33, 67]); // one Pick, one vote: 🔥5 does not outweigh 🔥1
    expect(ml.viewerChoiceLabel).toMatch(/Capitals/);
    expect(tot).toMatchObject({ revealed: true, totalPickCount: 1 });
    expect(tot.choices.map((x) => x.percent).sort()).toEqual([0, 100]); // a real 100 / 0 from a single Pick — not 0 / 0
    expect(spr).toMatchObject({ revealed: false, totalPickCount: 0, hasViewerPick: false, viewerChoiceLabel: null, viewerConfidence: null });
    expect(spr.choices.every((x) => x.percent === null)).toBe(true); // withheld, not zero
    // The configured order is honoured (a different priority reorders them).
    const reordered = await getGameMarketSentiment({ userId: a, sport: "ice_hockey", homeTeamName: "Washington Capitals", awayTeamName: "New Jersey Devils", markets, templatePriority: ["SPREAD", "TOTAL", "MONEYLINE"] });
    expect(reordered.map((s) => s.marketId)).toEqual([spreadId, totalId, g.marketId]);
    // Someone who has predicted on nothing sees nothing revealed, anywhere.
    const nobody = await member("sent-none");
    const hidden = await getGameMarketSentiment({ userId: nobody, sport: "ice_hockey", homeTeamName: "Washington Capitals", awayTeamName: "New Jersey Devils", markets, templatePriority: ["MONEYLINE", "TOTAL", "SPREAD"] });
    expect(hidden.every((s) => !s.revealed && s.totalPickCount === 0 && s.choices.every((x) => x.percent === null))).toBe(true);
  });

  it("uses team-native labels on the Spread and a compact label on the Total", async () => {
    const g = await game();
    await addMarket(g.fixtureId, "TOTAL", 6);
    await addMarket(g.fixtureId, "SPREAD", -1.5);
    const markets = await listDisplayableMarketsForFixture(g.fixtureId);
    const viewer = await seedUser("sent-label");
    const sentiment = await getGameMarketSentiment({ userId: viewer, sport: "ice_hockey", homeTeamName: "Washington Capitals", awayTeamName: "New Jersey Devils", markets, templatePriority: ["MONEYLINE", "TOTAL", "SPREAD"] });
    const labels = Object.fromEntries(sentiment.map((s) => [s.label, s.choices.map((c) => c.label)]));
    expect(Object.keys(labels)).toEqual(["Moneyline", "Total 6", "Spread"]);
    expect(labels["Total 6"]).toEqual(["Over 6", "Under 6"]);
    expect(labels["Spread"].join(" ")).toMatch(/Washington Capitals [+-]1\.5/);
    expect(labels["Spread"].join(" ")).toMatch(/New Jersey Devils [+-]1\.5/);
  });
});
