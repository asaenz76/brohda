/**
 * Market terminal state. A Market whose Game is terminal (COMPLETED or CANCELLED) and whose Picks are all graded moves ACTIVE -> CLOSED
 * (the existing terminal state — never ARCHIVED, which grading reads as VOID). Nothing else changes: not results, not Picks, not
 * challenges, not money. It never reopens, ignores Games that aren't terminal, and is idempotent. Real local Supabase.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { closeFinishedMarkets } from "@/lib/prediction-markets/lifecycle";
import { runGradingLifecycleJob } from "@/lib/predictions/grading-lifecycle";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { listActiveMarketsForFixture, listDisplayableMarketsForFixture, listDisplayableMarketsForFixtures } from "@/lib/prediction-markets/repository";

const admin = getTestAdminClient();

beforeEach(async () => {
  const { error } = await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
  if (error) throw error;
});

const marketRow = async (id: string) => (await admin.from("markets").select("status, closed_at, resolved_outcome").eq("id", id).single()).data!;
const picksOf = async (marketId: string) => (await admin.from("predictions").select("id, user_id, selected_outcome, lifecycle_state, result, resolved_outcome_snapshot, graded_at").eq("market_id", marketId).order("id")).data!;

/** A Game with one Pick per side. */
async function gameWithPicks(options: Parameters<typeof seedGame>[0] = {}) {
  const g = await seedGame(options);
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedPick(a, g.marketId, "YES");
  await seedPick(b, g.marketId, "NO");
  return { ...g, a, b };
}

describe("when a Market is closed", () => {
  it("a completed Game whose Picks are all graded: ACTIVE -> CLOSED, with closed_at set", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    const summary = await runGradingLifecycleJob(recordGradedPredictionResult);
    expect(summary.failures).toEqual([]);
    expect(summary.marketsClosed).toBeGreaterThanOrEqual(1);
    const row = await marketRow(g.marketId);
    expect(row.status).toBe("CLOSED");
    expect(row.closed_at).not.toBeNull();
  });

  it("completed but NOT yet graded: it stays ACTIVE until grading has run (the close is judged on graded Picks)", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    expect(await closeFinishedMarkets()).not.toContain(g.marketId); // Picks still PENDING
    expect((await marketRow(g.marketId)).status).toBe("ACTIVE");
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");
  });

  it("a tied Moneyline (Picks VOID) closes like any other graded Market", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 14, away_score: 14 });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await picksOf(g.marketId)).map((p) => p.result)).toEqual(["VOID", "VOID"]);
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");
  });

  it("a cancelled Game (Picks VOID) closes", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "CANCELLED" });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await picksOf(g.marketId)).map((p) => p.result)).toEqual(["VOID", "VOID"]);
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");
  });

  it("a completed Game with no Picks at all closes (nothing is waiting to be graded)", async () => {
    const g = await seedGame();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 3, away_score: 0 });
    expect(await closeFinishedMarkets()).toContain(g.marketId);
  });
});

describe("what it leaves alone", () => {
  it.each(["POSTPONED", "SUSPENDED", "ABANDONED", "AWARDED", "UNKNOWN", "LIVE", "HALFTIME", "NOT_STARTED"])("a %s Game is not terminal: its Market stays ACTIVE and its Picks stay pending", async (status) => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: status });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await marketRow(g.marketId)).status).toBe("ACTIVE");
    expect((await picksOf(g.marketId)).every((p) => p.lifecycle_state === "PENDING")).toBe(true);
  });

  it("an INACTIVE (superseded) Market and an ARCHIVED one are not touched", async () => {
    const inactive = await seedGame();
    const archived = await seedGame();
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", inactive.marketId);
    await admin.from("markets").update({ status: "ARCHIVED" }).eq("id", archived.marketId);
    await setFixture(inactive.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
    await setFixture(archived.fixtureId, { internal_status: "COMPLETED", home_score: 1, away_score: 0 });
    await closeFinishedMarkets();
    expect((await marketRow(inactive.marketId)).status).toBe("INACTIVE");
    expect((await marketRow(archived.marketId)).status).toBe("ARCHIVED");
  });

  it("closing never changes a Pick: results, graded_at and resolved snapshots are exactly what grading wrote", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    const afterGrading = await picksOf(g.marketId);
    expect(afterGrading.map((p) => p.result).sort()).toEqual(["CORRECT", "INCORRECT"]);
    expect(await closeFinishedMarkets()).toEqual([]); // already closed — a second pass changes nothing
    expect(await picksOf(g.marketId)).toEqual(afterGrading);
  });
});

describe("idempotent, and it never reopens", () => {
  it("running the job repeatedly closes each Market once; closed_at is stable", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    const first = await runGradingLifecycleJob(recordGradedPredictionResult);
    expect(first.marketsClosed).toBeGreaterThanOrEqual(1);
    const closedAt = (await marketRow(g.marketId)).closed_at;
    const second = await runGradingLifecycleJob(recordGradedPredictionResult);
    expect(second.marketsClosed).toBe(0);
    expect((await marketRow(g.marketId)).closed_at).toBe(closedAt);
  });

  it("a CLOSED Market is never set back to ACTIVE by the lifecycle, whatever the Game later reports", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    await setFixture(g.fixtureId, { internal_status: "NOT_STARTED" }); // e.g. a bad provider correction
    await runGradingLifecycleJob(recordGradedPredictionResult);
    await closeFinishedMarkets();
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");
  });
});

describe("a finished Game still renders", () => {
  it("the page/feed reader includes a CLOSED Market; the strict 'active' reader does not", async () => {
    const g = await gameWithPicks();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await listDisplayableMarketsForFixture(g.fixtureId)).map((m) => [m.id, m.status])).toEqual([[g.marketId, "CLOSED"]]);
    expect((await listDisplayableMarketsForFixtures([g.fixtureId])).map((m) => m.id)).toEqual([g.marketId]);
    expect(await listActiveMarketsForFixture(g.fixtureId)).toEqual([]);
  });

  it("an INACTIVE (superseded) Market stays out of the displayable set", async () => {
    const g = await seedGame();
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", g.marketId);
    expect(await listDisplayableMarketsForFixture(g.fixtureId)).toEqual([]);
  });
});

describe("closing does not disturb Call BS or money", () => {
  it("an accepted challenge on a closed Market still resolves afterwards, and its Position still settles", async () => {
    // Call BS + money both resolve from the graded Picks, never from markets.status.
    const { callBS, acceptCallBS } = await import("@/lib/challenges/repository");
    const { runChallengeLifecycleJob } = await import("@/lib/challenges/lifecycle");
    const g = await seedGame();
    const a = await seedUser("a");
    const b = await seedUser("b");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    expect((await acceptCallBS(sent.challenge.id, b)).outcome).toBe("accepted");
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingLifecycleJob(recordGradedPredictionResult); // grades AND closes
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");
    const lifecycle = await runChallengeLifecycleJob();
    expect(lifecycle.resolved).toBeGreaterThanOrEqual(1);
    const { data: challenge } = await admin.from("challenges").select("status, result").eq("id", sent.challenge.id).single();
    expect(challenge).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });
  });

  it("a committed money Position on a closed Market still settles, with the fee it was snapshotted with", async () => {
    const { proposeMoney, acceptMonetaryProposal } = await import("@/lib/monetary/repository");
    const { runSettlementJob } = await import("@/lib/monetary/settlement-runner");
    const { randomUUID } = await import("node:crypto");
    await admin.from("platform_settings").update({ monetary_p2p_enabled: true, p2p_fee_bps: 500, monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000 }).eq("id", true);
    const g = await seedGame();
    const a = await seedUser("a");
    const b = await seedUser("b");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    for (const user of [a, b]) {
      const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: user, p_type: "manual_deposit", p_direction: "credit", p_amount: 5000, p_admin_id: null, p_reason: "test funding", p_idempotency_key: randomUUID() });
      if (error) throw error;
    }
    const proposed = await proposeMoney(a, bPick, 1000, randomUUID());
    if (!proposed.ok) throw new Error(proposed.error);
    const accepted = await acceptMonetaryProposal(proposed.proposal.id, b);
    if (accepted.outcome !== "accepted" || !accepted.position) throw new Error(accepted.outcome);

    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingLifecycleJob(recordGradedPredictionResult);
    expect((await marketRow(g.marketId)).status).toBe("CLOSED");

    const settlement = await runSettlementJob();
    expect(settlement.failures.filter((f) => f.positionId === accepted.position!.id)).toEqual([]);
    const { data: position } = await admin.from("monetary_positions").select("settlement_status, settlement_id").eq("id", accepted.position.id).single();
    expect(position?.settlement_status).toBe("SETTLED");
    const { data: result } = await admin.from("monetary_position_settlements").select("outcome, fee_amount").eq("id", position!.settlement_id).single();
    expect(result).toMatchObject({ outcome: "PROPOSER_WINS", fee_amount: 50 });
  });
});
