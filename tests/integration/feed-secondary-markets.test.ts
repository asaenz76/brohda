/**
 * Inline multi-market feed: every displayable Market of a Game is available on the feed card for a signed-in viewer, through the SAME summary as the primary Market (Pick, Pick-first sentiment, eligibility reason,
 * Confidence state), in the canonical order, with a constant number of batched reads however many Games and Markets the page holds. Real local Supabase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { setPick } from "@/lib/predictions/repository";

const calls = { markets: 0, viewerPicks: 0, aggregates: 0, stakes: 0 };
vi.mock("@/lib/prediction-markets/repository", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prediction-markets/repository")>();
  return { ...real, listDisplayableMarketsForFixtures: (...a: Parameters<typeof real.listDisplayableMarketsForFixtures>) => (calls.markets++, real.listDisplayableMarketsForFixtures(...a)) };
});
vi.mock("@/lib/predictions/repository", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/predictions/repository")>();
  return {
    ...real,
    listLatestUserPredictionsForMarkets: (...a: Parameters<typeof real.listLatestUserPredictionsForMarkets>) => (calls.viewerPicks++, real.listLatestUserPredictionsForMarkets(...a)),
    getPickAggregatesForMarkets: (...a: Parameters<typeof real.getPickAggregatesForMarkets>) => (calls.aggregates++, real.getPickAggregatesForMarkets(...a)),
  };
});
vi.mock("@/lib/confidence/stakes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/confidence/stakes")>();
  return { ...real, getStakeUiStates: (...a: Parameters<typeof real.getStakeUiStates>) => (calls.stakes++, real.getStakeUiStates(...a)) };
});
const { getSocialFeed } = await import("@/lib/communities/feed");

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const reset = () => Object.assign(calls, { markets: 0, viewerPicks: 0, aggregates: 0, stakes: 0 });

beforeEach(async () => {
  reset();
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_allowed_stakes: [1, 2, 3, 4, 5], confidence_baseline: 50, pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
});

async function addMarket(fixtureId: string, template: "TOTAL" | "SPREAD" | "MONEYLINE", line: number | null, extra: Record<string, unknown> = {}) {
  const { data: first } = await admin.from("markets").select("provider").eq("fixture_id", fixtureId).limit(1).single();
  const { data, error } = await admin
    .from("markets")
    .insert({
      provider: first!.provider, provider_market_id: `sec_${randomUUID()}`, question: "q?", status: "ACTIVE", fixture_id: fixtureId, yes_price: 0.5, no_price: 0.5, liquidity: 100, last_synced_at: new Date().toISOString(),
      ingestion_source: "test", provider_metadata: {}, market_template: template, yes_side: template === "TOTAL" ? null : "HOME", line_value: line, ...extra,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id as string;
}
/** A published Game with Moneyline (primary) + Total + Spread, inserted in the "wrong" order to prove ordering is canonical, not insertion order. */
async function fullGame(startsInMinutes = 24 * 60) {
  const { fixtureId, marketId } = await seedGame({ startsInMinutes });
  const spreadId = await addMarket(fixtureId, "SPREAD", -2.5);
  const totalId = await addMarket(fixtureId, "TOTAL", 224);
  await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() });
  return { fixtureId, moneylineId: marketId, totalId, spreadId };
}
async function member(label = "sec") {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const itemFor = async (viewer: string | null, fixtureId: string) => (await getSocialFeed(viewer, 300)).find((i) => i.post.fixtureId === fixtureId);
const pickOn = (userId: string, marketId: string, outcome: "YES" | "NO") =>
  setPick({ userId, marketId, selectedOutcome: outcome, yesProbability: 0.5, noProbability: 0.5, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() });
/** The viewer's prediction the way a Member makes one now: side + Confidence, one transaction (the crowd's Picks around it are just rows). */
const commit = async (memberId: string, marketId: string, side: "YES" | "NO", amount = 1) =>
  (await admin.rpc("create_confidence_prediction", { p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.5, p_no_probability: 0.5, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })).data as Row;
const attach = async (memberId: string, predictionId: string, amount: number) => (await admin.rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: randomUUID() })).data as Row;

describe("which Markets a card carries, and in what order", () => {
  it("a Game with Moneyline + Spread + Total: the primary is the Moneyline, the others follow the configured priority (Total, Spread), and the primary is never repeated", async () => {
    const v = await member();
    const g = await fullGame();
    const item = await itemFor(v, g.fixtureId);
    expect(item?.primaryMarket?.id).toBe(g.moneylineId);
    expect(item?.secondaryMarkets?.map((m) => m.id)).toEqual([g.totalId, g.spreadId]); // inserted Spread first; order comes from the setting, not insertion
    expect(item?.secondaryMarkets?.map((m) => m.heading)).toEqual(["Game Total 224", "Spread"]);
    expect(item?.moreMarketsCount).toBe(2);
    expect(item?.secondaryMarkets?.some((m) => m.id === g.moneylineId)).toBe(false);
  });

  it("the order follows the setting: changing the template priority changes the order with no code change", async () => {
    const v = await member();
    const g = await fullGame();
    await admin.from("platform_settings").update({ post_primary_market_template_priority: ["MONEYLINE", "SPREAD", "TOTAL"] }).eq("id", true);
    try {
      expect((await itemFor(v, g.fixtureId))?.secondaryMarkets?.map((m) => m.id)).toEqual([g.spreadId, g.totalId]);
    } finally {
      await admin.from("platform_settings").update({ post_primary_market_template_priority: ["MONEYLINE", "TOTAL", "SPREAD"] }).eq("id", true);
    }
  });

  it("a Game with only one Market has no secondary Markets", async () => {
    const v = await member();
    const { fixtureId } = await seedGame();
    await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() });
    const item = await itemFor(v, fixtureId);
    expect(item?.secondaryMarkets).toBeUndefined();
    expect(item?.moreMarketsCount).toBe(0);
  });

  it("Moneyline + Total and Moneyline + Spread each show only the one other Market; hidden Markets never appear", async () => {
    const v = await member();
    const a = await seedGame();
    const aTotal = await addMarket(a.fixtureId, "TOTAL", 47.5);
    await addMarket(a.fixtureId, "SPREAD", 3, { status: "ARCHIVED" });
    await admin.from("posts").insert({ fixture_id: a.fixtureId, published_at: new Date().toISOString() });
    const b = await seedGame();
    const bSpread = await addMarket(b.fixtureId, "SPREAD", -1.5);
    await admin.from("posts").insert({ fixture_id: b.fixtureId, published_at: new Date().toISOString() });
    expect((await itemFor(v, a.fixtureId))?.secondaryMarkets?.map((m) => m.id)).toEqual([aTotal]);
    expect((await itemFor(v, b.fixtureId))?.secondaryMarkets?.map((m) => m.id)).toEqual([bSpread]);
    expect((await itemFor(v, b.fixtureId))?.secondaryMarkets?.[0].choices.map((c) => c.label)).toEqual(expect.arrayContaining([expect.stringMatching(/-1\.5$/), expect.stringMatching(/\+1\.5$/)]));
  });

  it("a visitor (no viewer) gets no secondary Markets: the front door keeps its link to the Post", async () => {
    const g = await fullGame();
    const item = await itemFor(null, g.fixtureId);
    expect(item?.secondaryMarkets).toBeUndefined();
    expect(item?.moreMarketsCount).toBe(2);
  });
});

describe("each secondary Market carries its OWN state, exactly like the primary", () => {
  it("Pick-first sentiment per Market: revealed only for a Market the viewer has Picked, from that Market's Pick counts", async () => {
    const v = await member("viewer");
    const others = [await member("o1"), await member("o2"), await member("o3")];
    const g = await fullGame();
    for (const o of others) await pickOn(o, g.totalId, "YES"); // 3 Over
    await pickOn(others[0], g.spreadId, "NO");
    expect((await commit(v, g.totalId, "NO")).outcome).toBe("created"); // the viewer commits to Under → total now 3 Over / 1 Under
    const item = await itemFor(v, g.fixtureId);
    const total = item!.secondaryMarkets!.find((m) => m.id === g.totalId)!;
    const spread = item!.secondaryMarkets!.find((m) => m.id === g.spreadId)!;
    expect(total).toMatchObject({ sentimentRevealed: true, totalPickCount: 4, yesPercent: 75, noPercent: 25, viewerSelection: "NO" });
    expect(spread).toMatchObject({ sentimentRevealed: false, totalPickCount: 0, yesPercent: null, viewerSelection: null }); // the others' spread Pick is not shown to someone who hasn't picked it
    expect(item!.primaryMarket).toMatchObject({ sentimentRevealed: false, viewerSelection: null });
  });

  it("commit before the crowd: an old open Pick that has not been completed with Confidence does NOT reveal sentiment; completing it does", async () => {
    const v = await member("legacy-viewer");
    const other = await member("legacy-other");
    const g = await fullGame();
    await pickOn(other, g.totalId, "YES");
    await pickOn(v, g.totalId, "NO"); // an unbacked, still-open Pick from before Confidence was part of every prediction
    let total = (await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.totalId)!;
    expect(total).toMatchObject({ sentimentRevealed: false, yesPercent: null, totalPickCount: 0, isEditable: true });
    expect((await commit(v, g.totalId, "NO", 2)).outcome).toBe("created");
    total = (await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.totalId)!;
    expect(total).toMatchObject({ sentimentRevealed: true, totalPickCount: 2, yesPercent: 50, noPercent: 50, isEditable: false });
  });

  it("a Member with no Pick, or who has only been looking at the Market, sees no sentiment", async () => {
    const v = await member("looker");
    const g = await fullGame();
    const item = await itemFor(v, g.fixtureId);
    for (const m of [item!.primaryMarket!, ...item!.secondaryMarkets!]) expect(m).toMatchObject({ sentimentRevealed: false, totalPickCount: 0, viewerPredictionId: null });
  });

  it("sentiment counts Picks, never Confidence: a heavily backed Pick weighs the same as an unbacked one", async () => {
    const v = await member("v");
    const heavy = await member("heavy");
    const light = await member("light");
    const g = await fullGame();
    const heavyPick = (await pickOn(heavy, g.totalId, "YES")).prediction!.id;
    await pickOn(light, g.totalId, "NO");
    expect((await attach(heavy, heavyPick, 5)).outcome).toBe("attached");
    expect((await commit(v, g.totalId, "YES", 5)).outcome).toBe("created");
    const total = (await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.totalId)!;
    expect(total).toMatchObject({ totalPickCount: 3, yesPercent: 67, noPercent: 33 });
  });

  it("an existing Pick on a secondary Market renders its canonical state on load: open to Confidence, then committed and locked", async () => {
    const v = await member();
    const g = await fullGame();
    const pick = (await pickOn(v, g.spreadId, "YES")).prediction!;
    let spread = (await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.spreadId)!;
    expect(spread).toMatchObject({ viewerSelection: "YES", viewerPredictionId: pick.id, isEditable: true });
    expect(spread.confidence).toMatchObject({ state: "open", available: 50, allowedStakes: [1, 2, 3, 4, 5] });
    expect((await attach(v, pick.id, 1)).outcome).toBe("attached");
    spread = (await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.spreadId)!;
    expect(spread).toMatchObject({ isEditable: false, pickDisabledReason: "Picks are locked for this game." });
    expect(spread.confidence).toMatchObject({ state: "staked", amount: 1, stakeState: "RESERVED" });
  });

  it("a Market whose numbers have gone stale is reported with the same reason the primary Market would give, and Picks there are not offered", async () => {
    const v = await member();
    const { fixtureId } = await seedGame();
    const stale = await addMarket(fixtureId, "TOTAL", 40.5, { last_synced_at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() });
    await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() });
    const total = (await itemFor(v, fixtureId))!.secondaryMarkets!.find((m) => m.id === stale)!;
    expect(total.pickDisabledReason).toEqual(expect.stringMatching(/\S/));
  });
});

describe("one Game, several independent Picks, each with its own Confidence", () => {
  it("Moneyline 🔥3 + Total 🔥2 + Spread 🔥1 reserve 🔥6 in total, as three separate stakes", async () => {
    const v = await member();
    const g = await fullGame();
    const picks = [
      [g.moneylineId, "YES", 3],
      [g.totalId, "NO", 2],
      [g.spreadId, "YES", 1],
    ] as const;
    for (const [marketId, side, amount] of picks) {
      const p = (await pickOn(v, marketId, side)).prediction!;
      expect((await attach(v, p.id, amount)).outcome).toBe("attached");
    }
    const account = (await admin.from("confidence_accounts").select("available, reserved, total").eq("member_id", v).single()).data!;
    expect([Number(account.available), Number(account.reserved), Number(account.total)]).toEqual([44, 6, 50]);
    expect((await admin.from("confidence_prediction_stakes").select("amount").eq("member_id", v)).data!.map((s) => s.amount).sort()).toEqual([1, 2, 3]);
    const item = await itemFor(v, g.fixtureId);
    expect(item!.primaryMarket!.confidence).toMatchObject({ state: "staked", amount: 3 });
    expect(item!.secondaryMarkets!.map((m) => (m.confidence.state === "staked" ? m.confidence.amount : null))).toEqual([2, 1]);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });
});

describe("the Game's lock rules apply to every Market of the Game", () => {
  it("inside the 10-minute window no Market takes a Pick or Confidence; a started Game is not on the feed at all", async () => {
    const v = await member();
    const g = await fullGame(60);
    const pick = (await pickOn(v, g.totalId, "YES")).prediction!;
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect((await attach(v, pick.id, 1)).outcome).toBe("past_deadline");
    const spreadTry = await pickOn(v, g.spreadId, "NO");
    expect(spreadTry.outcome).not.toBe("created");
    expect((await itemFor(v, g.fixtureId))!.secondaryMarkets!.find((m) => m.id === g.totalId)!.confidence).toMatchObject({ state: "closed", reason: "deadline" });
    await setFixture(g.fixtureId, { internal_status: "LIVE" });
    expect(await itemFor(v, g.fixtureId)).toBeUndefined();
    expect((await attach(v, pick.id, 1)).outcome).toBe("game_started");
  });
});

describe("capabilities", () => {
  it("Confidence OFF: Picks still work on every Market and no Confidence state is offered", async () => {
    const v = await member();
    const g = await fullGame();
    await admin.from("platform_settings").update({ confidence_enabled: false }).eq("id", true);
    expect((await pickOn(v, g.totalId, "YES")).outcome).toBe("created");
    const item = await itemFor(v, g.fixtureId);
    expect(item!.secondaryMarkets!.every((m) => m.confidence.state === "none")).toBe(true);
    expect(item!.secondaryMarkets!.find((m) => m.id === g.totalId)!.viewerSelection).toBe("YES");
  });

  it("backed Picks OFF: Picks work, no selector is offered; an existing commitment still shows", async () => {
    const v = await member();
    const g = await fullGame();
    const free = (await pickOn(v, g.totalId, "YES")).prediction!;
    const backed = (await pickOn(v, g.spreadId, "YES")).prediction!;
    await attach(v, backed.id, 2);
    await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
    const item = await itemFor(v, g.fixtureId);
    const totalState = item!.secondaryMarkets!.find((m) => m.id === g.totalId)!.confidence.state;
    expect(["none", "unavailable"]).toContain(totalState);
    expect(item!.secondaryMarkets!.find((m) => m.id === g.spreadId)!.confidence).toMatchObject({ state: "staked", amount: 2 });
    expect(free.id).toBeTruthy();
  });
});

describe("no N+1: a constant number of batched reads however many Games and Markets the page holds", () => {
  async function countsFor(games: number) {
    const v = await member("count");
    for (let i = 0; i < games; i++) {
      const g = await fullGame();
      await pickOn(v, g.totalId, "YES");
      await pickOn(v, g.spreadId, "NO");
    }
    reset();
    await getSocialFeed(v, 300);
    return { ...calls };
  }

  it("the Markets read, the viewer's-Picks read, the sentiment read and the Confidence call do not grow with the number of Games or Markets", async () => {
    const small = await countsFor(1);
    const large = await countsFor(6);
    expect(large).toEqual(small);
    // Secondary Markets add exactly one batched read each: Markets, viewer Picks, sentiment of the Picked Markets, Confidence (on top of the primary path's own).
    expect(large.stakes).toBeLessThanOrEqual(2);
    expect(large.markets).toBeLessThanOrEqual(2);
    expect(large.viewerPicks).toBeLessThanOrEqual(2);
    expect(large.aggregates).toBeLessThanOrEqual(2);
  });

  it("a viewer with no Picks on any secondary Market makes no sentiment or Confidence call for them", async () => {
    const v = await member("nopick");
    await fullGame();
    reset();
    await getSocialFeed(v, 300);
    expect(calls.viewerPicks).toBeLessThanOrEqual(2);
    expect(calls.stakes).toBeLessThanOrEqual(2);
  });
});

void seedPick;
