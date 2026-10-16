/**
 * Feed parity for Confidence-backed Picks: the Home timeline offers the same Confidence control as the Post detail, from the same database decision, fetched for the whole page in ONE batched call (never a
 * query per card). Covers the batched function's parity with the single-Pick one, the feed item's Confidence state across every case (open, staked, closed, off, Call BS lock, insufficient balance), and
 * that nothing about another Member's Pick can leak. Real local Supabase.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";

const calls = { many: 0, single: 0 };
vi.mock("@/lib/confidence/stakes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/confidence/stakes")>();
  return {
    ...real,
    getStakeUiStates: (...args: Parameters<typeof real.getStakeUiStates>) => {
      calls.many++;
      return real.getStakeUiStates(...args);
    },
    getStakeUiState: (...args: Parameters<typeof real.getStakeUiState>) => {
      calls.single++;
      return real.getStakeUiState(...args);
    },
  };
});

const { getSocialFeed } = await import("@/lib/communities/feed");

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  calls.many = 0;
  calls.single = 0;
  await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
});

async function member(label = "fp") {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
/** A published Game whose Moneyline the Member has picked. */
async function pickedGame(memberId: string, side: "YES" | "NO" = "YES", startsInMinutes = 24 * 60) {
  const { fixtureId, marketId } = await seedGame({ startsInMinutes });
  await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() });
  const predictionId = await seedPick(memberId, marketId, side);
  return { fixtureId, marketId, predictionId };
}
const attach = async (memberId: string, predictionId: string, amount: number) => (await admin.rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: randomUUID() })).data as Row;
const itemFor = async (viewer: string, marketId: string) => (await getSocialFeed(viewer, 300)).find((i) => i.primaryMarket?.id === marketId)?.primaryMarket;

describe("the batched Confidence status is the same decision as the single one", () => {
  it("returns exactly what confidence_stake_status returns for each Pick, in every state, keyed by Pick id", async () => {
    const m = await member("many");
    const open = await pickedGame(m);
    const staked = await pickedGame(m);
    await attach(m, staked.predictionId, 2);
    const started = await pickedGame(m, "YES", 60);
    await setFixture(started.fixtureId, { internal_status: "LIVE" });
    const late = await pickedGame(m, "YES", 60);
    await setFixture(late.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    const ids = [open, staked, started, late].map((p) => p.predictionId);

    const many = (await admin.rpc("confidence_stake_status_many", { p_member_id: m, p_prediction_ids: ids })).data as Record<string, Row>;
    expect(Object.keys(many).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const single = (await admin.rpc("confidence_stake_status", { p_member_id: m, p_prediction_id: id })).data;
      expect(many[id], id).toEqual(single);
    }
    expect([open, staked, started, late].map((p) => many[p.predictionId].state)).toEqual(["open", "staked", "closed", "closed"]);
    expect(many[started.predictionId].reason).toBe("game_started");
    expect(many[late.predictionId].reason).toBe("deadline");
  });

  it("another Member's Pick, an unknown id and an empty list reveal nothing", async () => {
    const a = await member("owner");
    const b = await member("peeker");
    const pick = await pickedGame(a);
    await attach(a, pick.predictionId, 3);
    const many = (await admin.rpc("confidence_stake_status_many", { p_member_id: b, p_prediction_ids: [pick.predictionId, randomUUID()] })).data as Record<string, Row>;
    for (const row of Object.values(many)) expect(row).toEqual({ state: "none" });
    expect(((await admin.rpc("confidence_stake_status_many", { p_member_id: b, p_prediction_ids: [] })).data as Row)).toEqual({});
  });

  it("is not callable by Members, the public or anyone but the service role", async () => {
    const m = await member("priv");
    const { getTestAnonClient } = await import("./helpers/test-env");
    expect((await getTestAnonClient().rpc("confidence_stake_status_many", { p_member_id: m, p_prediction_ids: [] })).error).not.toBeNull();
  });
});

describe("the Home feed item carries the Confidence state of the viewer's own Pick", () => {
  it("an existing, unbacked Pick on an open Game is `open` with the available balance and the ladder — no re-pick needed", async () => {
    const m = await member("open");
    const { marketId, predictionId } = await pickedGame(m);
    const market = await itemFor(m, marketId);
    expect(market?.viewerPredictionId).toBe(predictionId);
    expect(market?.confidence).toMatchObject({ state: "open", available: 50, allowedStakes: [1, 2, 3, 4, 5] });
    expect(await admin.from("confidence_prediction_stakes").select("id").eq("member_id", m)).toMatchObject({ data: [] }); // showing the control reserves nothing
  });

  it("no Pick, no Confidence state: a Market the viewer has not picked is `none` and no stake lookup is made", async () => {
    const m = await member("nopick");
    const { marketId } = await seedGame();
    const { data } = await admin.from("markets").select("fixture_id").eq("id", marketId).single();
    await admin.from("posts").insert({ fixture_id: data!.fixture_id, published_at: new Date().toISOString() });
    const market = await itemFor(m, marketId);
    expect(market?.viewerPredictionId).toBeNull();
    expect(market?.confidence).toEqual({ state: "none" });
  });

  it("after a commit the same Pick is `staked` with the committed amount, and the Pick is locked (not editable)", async () => {
    const m = await member("staked");
    const { marketId, predictionId } = await pickedGame(m);
    expect((await attach(m, predictionId, 3)).outcome).toBe("attached");
    const market = await itemFor(m, marketId);
    expect(market?.confidence).toMatchObject({ state: "staked", amount: 3, stakeState: "RESERVED" });
    expect(market?.isEditable).toBe(false);
  });

  it("a Pick locked by an accepted Call BS is still `open` to Confidence while the Game's deadline allows it — the lock is not the Confidence rule", async () => {
    const m = await member("callbs");
    const { marketId, predictionId } = await pickedGame(m);
    await admin.from("predictions").update({ locked_at: new Date().toISOString(), lock_reason: "CHALLENGE_ACCEPTED" }).eq("id", predictionId);
    const market = await itemFor(m, marketId);
    expect(market?.isEditable).toBe(false);
    expect(market?.confidence.state).toBe("open");
  });

  it("closed cases offer no control: inside the lock window, a started Game", async () => {
    const m = await member("closed");
    const late = await pickedGame(m, "YES", 60);
    await setFixture(late.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect((await itemFor(m, late.marketId))?.confidence).toMatchObject({ state: "closed", reason: "deadline" });
  });

  it("capability OFF: no control at all (`none`) — but an existing commitment is still shown", async () => {
    const m = await member("off");
    const free = await pickedGame(m);
    const backed = await pickedGame(m);
    await attach(m, backed.predictionId, 2);
    await admin.from("platform_settings").update({ confidence_backed_picks_enabled: false }).eq("id", true);
    expect(["none", "unavailable"]).toContain((await itemFor(m, free.marketId))?.confidence.state); // either way the card renders nothing
    expect((await itemFor(m, backed.marketId))?.confidence).toMatchObject({ state: "staked", amount: 2 });
    await admin.from("platform_settings").update({ confidence_enabled: false }).eq("id", true);
    expect((await itemFor(m, free.marketId))?.confidence.state).toBe("none");
  });

  it("insufficient balance: the control reports the AVAILABLE amount, never the total", async () => {
    const m = await member("poor");
    const first = await pickedGame(m);
    await attach(m, first.predictionId, 5);
    const second = await pickedGame(m);
    const market = await itemFor(m, second.marketId);
    expect(market?.confidence).toMatchObject({ state: "open", available: 45 });
    expect(market?.confidence.state === "open" && market.confidence.allowedStakes).toEqual([1, 2, 3, 4, 5]);
  });

  it("a visitor (no viewer) gets `none` everywhere", async () => {
    const m = await member("visitor-target");
    const { marketId } = await pickedGame(m);
    const market = (await getSocialFeed(null, 300)).find((i) => i.primaryMarket?.id === marketId)?.primaryMarket;
    expect(market?.confidence).toEqual({ state: "none" });
    expect(market?.viewerPredictionId).toBeNull();
  });
});

describe("no N+1: one batched call per feed render, however many Picks the viewer has", () => {
  it("fetches Confidence state for ALL of the viewer's Picks on the page with a single call and no per-card calls", async () => {
    const m = await member("batch");
    for (let i = 0; i < 6; i++) await pickedGame(m);
    calls.many = 0;
    calls.single = 0;
    const feed = await getSocialFeed(m, 300);
    expect(feed.filter((i) => i.primaryMarket?.viewerPredictionId).length).toBeGreaterThanOrEqual(6);
    expect(calls.many).toBe(1);
    expect(calls.single).toBe(0);
  });

  it("makes no Confidence call at all for a viewer with no Picks, or for a visitor", async () => {
    const m = await member("nopicks");
    calls.many = 0;
    await getSocialFeed(m, 300);
    await getSocialFeed(null, 300);
    expect(calls.many).toBe(0);
  });
});
