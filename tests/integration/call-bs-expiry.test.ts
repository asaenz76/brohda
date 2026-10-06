/**
 * Pending Call BS expiry. A PENDING challenge that can no longer be accepted (the canonical T-10 cutoff passed, the Game left
 * NOT_STARTED, or the Market is no longer ACTIVE) becomes EXPIRED instead of staying PENDING for ever. Only PENDING rows are touched;
 * it is idempotent and race-safe against accept and decline; it sends no notification and moves no record. Real local Supabase.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { acceptCallBS, callBS, expireStaleChallenges } from "@/lib/challenges/repository";
import { runChallengeLifecycleJob } from "@/lib/challenges/lifecycle";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";

const admin = getTestAdminClient();

// Call BS is off by default and each file starts from the schema defaults (see helpers/isolation.ts): say what this file needs.
beforeEach(async () => {
  const { error } = await admin.from("platform_settings").update({ call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10 }).eq("id", true);
  if (error) throw error;
});

/** A Game 24h out with a YES user (a) and a NO user (b), and a PENDING Call BS from a to b. */
async function pendingChallenge(game?: { fixtureId: string; marketId: string }) {
  const g = game ?? (await seedGame());
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedPick(a, g.marketId, "YES");
  const bPick = await seedPick(b, g.marketId, "NO");
  const sent = await callBS(a, bPick);
  if (!sent.ok) throw new Error(`call bs: ${sent.error}`);
  return { ...g, a, b, challengeId: sent.challenge.id };
}

const statusOf = async (id: string) => (await admin.from("challenges").select("status, result, updated_at").eq("id", id).single()).data!;
const kickoffIn = (fixtureId: string, minutes: number) => setFixture(fixtureId, { scheduled_start_utc: new Date(Date.now() + minutes * 60_000).toISOString() });

describe("which pending challenges expire", () => {
  it("a pending challenge before T-10 stays pending", async () => {
    const c = await pendingChallenge();
    await kickoffIn(c.fixtureId, 11); // cutoff (T-10) is a minute away
    expect(await expireStaleChallenges()).toEqual([]);
    expect((await statusOf(c.challengeId)).status).toBe("PENDING");
  });

  it("at T-10 (and after) it expires", async () => {
    const atCutoff = await pendingChallenge();
    await kickoffIn(atCutoff.fixtureId, 10); // exactly the cutoff: now >= start - 10min
    const past = await pendingChallenge();
    await kickoffIn(past.fixtureId, 3);
    const expired = (await expireStaleChallenges()).map((c) => c.id);
    expect(expired).toContain(atCutoff.challengeId);
    expect(expired).toContain(past.challengeId);
    expect((await statusOf(atCutoff.challengeId)).status).toBe("EXPIRED");
    expect((await statusOf(past.challengeId)).status).toBe("EXPIRED");
  });

  it("the cutoff follows the live setting, not a hard-coded 10 minutes", async () => {
    const c = await pendingChallenge();
    await kickoffIn(c.fixtureId, 20);
    expect((await expireStaleChallenges()).map((x) => x.id)).not.toContain(c.challengeId); // 20 minutes out is before a 10-minute cutoff…
    expect((await statusOf(c.challengeId)).status).toBe("PENDING");
    await admin.from("platform_settings").update({ pick_lock_minutes_before_kickoff: 30 }).eq("id", true);
    expect((await expireStaleChallenges()).map((x) => x.id)).toContain(c.challengeId); // …but past a 30-minute one
    expect((await statusOf(c.challengeId)).status).toBe("EXPIRED");
  });

  it("a Game that starts early (no longer NOT_STARTED) expires it, even with kickoff still in the future", async () => {
    const c = await pendingChallenge();
    await setFixture(c.fixtureId, { internal_status: "LIVE" });
    expect((await expireStaleChallenges()).map((x) => x.id)).toEqual([c.challengeId]);
  });

  it("a Market that is no longer ACTIVE expires it", async () => {
    const c = await pendingChallenge();
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", c.marketId);
    expect((await expireStaleChallenges()).map((x) => x.id)).toEqual([c.challengeId]);
  });
});

describe("what it never touches", () => {
  it("an ACCEPTED challenge never expires, even long after the cutoff", async () => {
    const g = await seedGame();
    const a = await seedUser("a");
    const b = await seedUser("b");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    expect((await acceptCallBS(sent.challenge.id, b)).outcome).toBe("accepted");
    await kickoffIn(g.fixtureId, -60);
    await setFixture(g.fixtureId, { internal_status: "LIVE" });
    expect(await expireStaleChallenges()).toEqual([]);
    expect((await statusOf(sent.challenge.id)).status).toBe("ACCEPTED");
  });

  it("a RESOLVED challenge never changes (result and timestamps intact)", async () => {
    const g = await seedGame();
    const a = await seedUser("a");
    const b = await seedUser("b");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const sent = await callBS(a, bPick);
    if (!sent.ok) throw new Error(sent.error);
    await acceptCallBS(sent.challenge.id, b);
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingJob(recordGradedPredictionResult);
    const summary = await runChallengeLifecycleJob();
    expect(summary.resolved).toBeGreaterThanOrEqual(1);
    const before = await statusOf(sent.challenge.id);
    expect(before).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });
    expect(await expireStaleChallenges()).toEqual([]);
    expect(await statusOf(sent.challenge.id)).toEqual(before);
  });

  it("DECLINED and already-EXPIRED challenges are left exactly as they were", async () => {
    const c = await pendingChallenge();
    await admin.from("challenges").update({ status: "DECLINED", declined_at: new Date().toISOString() }).eq("id", c.challengeId);
    const d = await pendingChallenge();
    await admin.from("challenges").update({ status: "EXPIRED" }).eq("id", d.challengeId);
    const before = [await statusOf(c.challengeId), await statusOf(d.challengeId)];
    await kickoffIn(c.fixtureId, -5);
    await kickoffIn(d.fixtureId, -5);
    expect(await expireStaleChallenges()).toEqual([]);
    expect([await statusOf(c.challengeId), await statusOf(d.challengeId)]).toEqual(before);
  });
});

describe("safety", () => {
  it("is idempotent: a second sweep finds nothing and changes nothing", async () => {
    const c = await pendingChallenge();
    await kickoffIn(c.fixtureId, 2);
    expect((await expireStaleChallenges()).map((x) => x.id)).toEqual([c.challengeId]);
    const once = await statusOf(c.challengeId);
    expect(await expireStaleChallenges()).toEqual([]);
    expect(await statusOf(c.challengeId)).toEqual(once);
  });

  it("sends no notification, and moves no record: Call BS W-L and prediction accuracy are untouched", async () => {
    const c = await pendingChallenge();
    await kickoffIn(c.fixtureId, 2);
    const noteCount = async () => (await admin.from("notifications").select("id", { count: "exact", head: true }).eq("challenge_id", c.challengeId)).count;
    const record = async (id: string) => (await admin.rpc("get_call_bs_record", { p_user_id: id }).single()).data;
    const predictions = async (id: string) => (await admin.rpc("get_user_prediction_record", { p_user_id: id }).single()).data;
    const before = { n: await noteCount(), ra: await record(c.a), rb: await record(c.b), pa: await predictions(c.a) };
    await expireStaleChallenges();
    expect({ n: await noteCount(), ra: await record(c.a), rb: await record(c.b), pa: await predictions(c.a) }).toEqual(before);
    expect(before.n).toBe(0);
    expect(before.ra).toMatchObject({ wins: 0, losses: 0 });
  });

  it("preserves the existing displaced-challenge model: accepting one still expires the others, with the same status", async () => {
    const g = await seedGame();
    const a = await seedUser("a");
    const b = await seedUser("b");
    const c = await seedUser("c");
    await seedPick(a, g.marketId, "YES");
    const bPick = await seedPick(b, g.marketId, "NO");
    const cPick = await seedPick(c, g.marketId, "NO");
    const first = await callBS(a, bPick);
    const second = await callBS(a, cPick);
    if (!first.ok || !second.ok) throw new Error("setup");
    await acceptCallBS(first.challenge.id, b);
    expect((await statusOf(second.challenge.id)).status).toBe("EXPIRED"); // already expired by accept — the sweep has nothing to add
    expect(await expireStaleChallenges()).toEqual([]);
  });

  it("the lifecycle job reports the expiry and still resolves accepted challenges", async () => {
    const c = await pendingChallenge();
    await kickoffIn(c.fixtureId, 1);
    const summary = await runChallengeLifecycleJob();
    expect(summary.expired).toBe(1);
    expect(summary.failures).toEqual([]);
    expect((await statusOf(c.challengeId)).status).toBe("EXPIRED");
    expect((await runChallengeLifecycleJob()).expired).toBe(0); // and a re-run is a no-op
  });
});

describe("races are deterministic", () => {
  it("sweep vs accept on a stale challenge: it ends EXPIRED and is never accepted", async () => {
    for (let round = 0; round < 6; round += 1) {
      const c = await pendingChallenge();
      await kickoffIn(c.fixtureId, 2); // stale
      const [accepted] = await Promise.all([acceptCallBS(c.challengeId, c.b), expireStaleChallenges()]);
      expect(accepted.outcome, `round ${round}`).not.toBe("accepted");
      expect((await statusOf(c.challengeId)).status, `round ${round}`).toBe("EXPIRED");
    }
  });

  it("sweep vs accept on a still-valid challenge: the sweep never takes it; accept wins", async () => {
    for (let round = 0; round < 4; round += 1) {
      const c = await pendingChallenge();
      const [accepted, swept] = await Promise.all([acceptCallBS(c.challengeId, c.b), expireStaleChallenges()]);
      expect(swept.map((x) => x.id), `round ${round}`).not.toContain(c.challengeId);
      expect(accepted.outcome, `round ${round}`).toBe("accepted");
      expect((await statusOf(c.challengeId)).status, `round ${round}`).toBe("ACCEPTED");
    }
  });

  it("sweep vs decline on a stale challenge: exactly one wins, and the row is in exactly one terminal state", async () => {
    for (let round = 0; round < 6; round += 1) {
      const c = await pendingChallenge();
      await kickoffIn(c.fixtureId, 2);
      const [decline] = await Promise.all([admin.rpc("decline_call_bs", { p_challenge_id: c.challengeId, p_recipient_user_id: c.b }), expireStaleChallenges()]);
      const final = (await admin.from("challenges").select("status, declined_at").eq("id", c.challengeId).single()).data!;
      expect(["DECLINED", "EXPIRED"], `round ${round}`).toContain(final.status);
      // The DB's own shape rule makes DECLINED <=> declined_at set; a decline that errored must have lost to the sweep.
      expect(final.status === "DECLINED", `round ${round}`).toBe(!decline.error);
      expect(final.status === "DECLINED", `round ${round}`).toBe(final.declined_at !== null);
    }
  });
});
