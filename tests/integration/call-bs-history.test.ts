/**
 * Integration coverage for the Call BS record, the pair-specific head-to-head
 * and the Profile's recent history, against the real local Supabase. Every
 * resolved result is produced through the real path (call_bs -> accept_call_bs
 * -> grading -> the resolver), never inserted: the record must come from
 * canonical challenge resolution. Free Call BS only — no money anywhere.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

vi.mock("server-only", () => ({}));

import { setPick } from "@/lib/predictions/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { callBS, acceptCallBS, declineCallBS } from "@/lib/challenges/repository";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { getHeadToHeadRecords, listCallBsHistory } from "@/lib/challenges/history";

const admin = getTestAdminClient();
const suffix = randomUUID().slice(0, 8);
const created = { users: [] as string[], fixtures: [] as string[], markets: [] as string[], posts: [] as string[] };

async function createUser(label: string) {
  const { data, error } = await admin.auth.admin.createUser({ email: `cbh-${label}-${suffix}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label} ${suffix}`, username: `cbh${label}${suffix}`, role: "player", is_active: true });
  created.users.push(data.user.id);
  return data.user.id as string;
}

async function createGame(label: string) {
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: `cbh-${randomUUID()}`,
      sport: "american_football",
      home_team_name: `${label} Home ${suffix}`,
      away_team_name: `${label} Away ${suffix}`,
      scheduled_start_utc: new Date(Date.now() + 48 * 3600_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("fixture");
  created.fixtures.push(fixture.id);
  const payload: NormalizedMarket = {
    provider: "api_nfl",
    providerMarketId: `cbh_${randomUUID()}`,
    providerEventId: null,
    question: `Will ${label} Home ${suffix} win?`,
    description: null,
    status: "ACTIVE",
    fixtureId: fixture.id,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: `${label} Home win`, no: `${label} Home do not win` } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
  };
  const { id: marketId } = await upsertMarket(payload);
  created.markets.push(marketId);
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  created.posts.push(post!.id);
  return { fixtureId: fixture.id as string, marketId, postId: post!.id as string };
}

async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO") {
  const { prediction, outcome } = await setPick({ userId, marketId, selectedOutcome, yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() });
  if (!prediction) throw new Error(`pick failed: ${outcome}`);
  return prediction.id;
}

// A VOID grading carries no resolved outcome (a database check constraint requires it to be null).
async function grade(id: string, result: "CORRECT" | "INCORRECT" | "VOID", outcome: "YES" | "NO" | null) {
  const { error } = await admin.from("predictions").update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: result === "VOID" ? null : outcome, graded_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

/** challenger (picks YES) calls BS on recipient (picks NO). `winner` decides the Market result; "VOID" voids both Picks. Returns the Game. */
async function resolvedChallenge(challenger: string, recipient: string, label: string, winner: "CHALLENGER" | "RECIPIENT" | "VOID") {
  const game = await createGame(label);
  const cPick = await pick(challenger, game.marketId, "YES");
  const rPick = await pick(recipient, game.marketId, "NO");
  const made = await callBS(challenger, rPick);
  if (!made.ok) throw new Error("callBS failed");
  await acceptCallBS(made.challenge.id, recipient);
  if (winner === "VOID") {
    await grade(cPick, "VOID", "YES");
    await grade(rPick, "VOID", "YES");
  } else {
    const marketResult = winner === "CHALLENGER" ? "YES" : "NO";
    await grade(cPick, winner === "CHALLENGER" ? "CORRECT" : "INCORRECT", marketResult);
    await grade(rPick, winner === "RECIPIENT" ? "CORRECT" : "INCORRECT", marketResult);
  }
  await resolveAcceptedChallenges();
  return { ...game, challengeId: made.challenge.id };
}

const rpcRecord = async (userId: string) => {
  const { data, error } = await admin.rpc("get_call_bs_record", { p_user_id: userId }).single();
  if (error) throw error;
  const r = data as { wins: number; losses: number; void: number };
  return { wins: r.wins, losses: r.losses, voids: r.void };
};

let A = "";
let B = "";
let C = "";
const games: Record<string, Awaited<ReturnType<typeof resolvedChallenge>>> = {};

beforeAll(async () => {
  // This file needs Call BS on. It used to pass only because some earlier file happened to leave it enabled; every file now starts from the
  // schema defaults (helpers/isolation.ts), so it says so itself.
  const { error: policyError } = await admin.from("platform_settings").update({ call_bs_enabled: true }).eq("id", true);
  if (policyError) throw policyError;

  A = await createUser("andre");
  B = await createUser("carlos");
  C = await createUser("marco");

  // Played in this order, so "newest resolved first" is the reverse.
  games.g1 = await resolvedChallenge(A, B, "One", "CHALLENGER"); // A beats B
  games.g2 = await resolvedChallenge(A, B, "Two", "RECIPIENT"); // B beats A
  games.g3 = await resolvedChallenge(B, A, "Three", "CHALLENGER"); // B (challenger) beats A
  games.g4 = await resolvedChallenge(A, B, "Four", "VOID"); // void
  games.g5 = await resolvedChallenge(A, C, "Five", "CHALLENGER"); // A beats C

  // Never-resolved states between A and B, each on its own Market: none of these may count.
  const pending = await createGame("Pending");
  await pick(A, pending.marketId, "YES");
  const bPending = await pick(B, pending.marketId, "NO");
  expect((await callBS(A, bPending)).ok).toBe(true);

  const declinedGame = await createGame("Declined");
  await pick(A, declinedGame.marketId, "YES");
  const bDeclined = await pick(B, declinedGame.marketId, "NO");
  const declined = await callBS(A, bDeclined);
  if (!declined.ok) throw new Error("setup");
  await declineCallBS(declined.challenge.id, B);

  const expiredGame = await createGame("Expired");
  await pick(A, expiredGame.marketId, "YES");
  const bExpired = await pick(B, expiredGame.marketId, "NO");
  const expired = await callBS(A, bExpired);
  if (!expired.ok) throw new Error("setup");
  await admin.from("challenges").update({ status: "EXPIRED" }).eq("id", expired.challenge.id);

  const acceptedGame = await createGame("Accepted");
  await pick(A, acceptedGame.marketId, "YES");
  const bAccepted = await pick(B, acceptedGame.marketId, "NO");
  const accepted = await callBS(A, bAccepted);
  if (!accepted.ok) throw new Error("setup");
  await acceptCallBS(accepted.challenge.id, B); // accepted, but its Game hasn't been graded
});

afterAll(async () => {
  const { data: rows } = await admin.from("challenges").select("id").in("market_id", created.markets);
  const challengeIds = (rows ?? []).map((r) => r.id);
  if (challengeIds.length) {
    await admin.from("notifications").delete().in("challenge_id", challengeIds);
    await admin.from("challenges").delete().in("id", challengeIds);
  }
  await admin.from("predictions").delete().in("market_id", created.markets);
  await admin.from("posts").delete().in("id", created.posts);
  await admin.from("markets").delete().in("id", created.markets);
  await admin.from("fixtures").delete().in("id", created.fixtures);
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
});

describe("overall Call BS record (canonical get_call_bs_record)", () => {
  it("counts only resolved results: pending, declined, expired and accepted-but-ungraded are all excluded; VOID is neither a win nor a loss", async () => {
    // A: beat B (g1), lost to B (g2), lost to B (g3), VOID (g4), beat C (g5)
    expect(await rpcRecord(A)).toEqual({ wins: 2, losses: 2, voids: 1 });
    expect(await rpcRecord(B)).toEqual({ wins: 2, losses: 1, voids: 1 });
    expect(await rpcRecord(C)).toEqual({ wins: 0, losses: 1, voids: 0 });
  });

  it("is 0-0-0 for someone with no Call BS at all", async () => {
    const stranger = await createUser("stranger");
    expect(await rpcRecord(stranger)).toEqual({ wins: 0, losses: 0, voids: 0 });
  });

  it("a second resolver run changes nothing — the same challenge is never counted twice", async () => {
    const before = [await rpcRecord(A), await rpcRecord(B), await rpcRecord(C)];
    await resolveAcceptedChallenges();
    await resolveAcceptedChallenges();
    expect([await rpcRecord(A), await rpcRecord(B), await rpcRecord(C)]).toEqual(before);
    expect((await listCallBsHistory(A, 50)).length).toBe(5);
  });
});

describe("pair-specific head-to-head", () => {
  it("is read from each side's own perspective — the mirror image of the same challenges — and excludes everything unresolved", async () => {
    const fromA = await getHeadToHeadRecords(A, [B, C]);
    expect(fromA.get(B)).toEqual({ wins: 1, losses: 2, voids: 1 });
    expect(fromA.get(C)).toEqual({ wins: 1, losses: 0, voids: 0 });
    const fromB = await getHeadToHeadRecords(B, [A]);
    expect(fromB.get(A)).toEqual({ wins: 2, losses: 1, voids: 1 });
    const fromC = await getHeadToHeadRecords(C, [A, B]);
    expect(fromC.get(A)).toEqual({ wins: 0, losses: 1, voids: 0 });
    expect(fromC.has(B)).toBe(false); // never met: no entry, so nothing to show
  });

  it("sums to the overall record across opponents (A's pair records add up to A's total)", async () => {
    const pairs = [...(await getHeadToHeadRecords(A, [B, C])).values()];
    const total = pairs.reduce((acc, r) => ({ wins: acc.wins + r.wins, losses: acc.losses + r.losses, voids: acc.voids + r.voids }), { wins: 0, losses: 0, voids: 0 });
    expect(total).toEqual(await rpcRecord(A));
  });

  it("answers many opponents in a bounded number of reads: two per 150 opponents, never one per opponent (no N+1)", async () => {
    const counting = (reads: string[]) => ({
      from: (table: string) => {
        reads.push(table);
        return admin.from(table as never);
      },
    });
    const few: string[] = [];
    await getHeadToHeadRecords(A, [B, C], counting(few) as never);
    expect(few).toEqual(["challenges", "challenges"]); // one read per direction
    const many: string[] = [];
    const strangers = Array.from({ length: 400 }, () => randomUUID());
    const result = await getHeadToHeadRecords(A, [B, C, ...strangers], counting(many) as never);
    expect(many).toHaveLength(2 * Math.ceil(402 / 150)); // 6 reads for 402 opponents, and no "URI too long"
    expect(result.get(B)).toEqual({ wins: 1, losses: 2, voids: 1 });
    expect(result.size).toBe(2); // strangers have no history, so no entries
  });

  it("collapses repeat resolutions of the same Pick against the same opponent into one counted result", async () => {
    // Its own pair of users: resolved challenges can't be deleted (service_role has no DELETE on them — history is immutable), so the
    // extra row this test adds must not leak into the other scenarios' counts.
    const D = await createUser("dana");
    const E = await createUser("erik");
    const game = await resolvedChallenge(D, E, "Repeat", "CHALLENGER"); // D beats E, once
    expect(await rpcRecord(D)).toEqual({ wins: 1, losses: 0, voids: 0 });

    // The very same pair of Picks challenged and resolved a second time (R7 permits it; the reputation rule counts it once).
    const { data: picks } = await admin.from("predictions").select("id, user_id").eq("market_id", game.marketId);
    const { data: original } = await admin.from("challenges").select("*").eq("id", game.challengeId).single();
    const { error } = await admin
      .from("challenges")
      .insert({ ...original!, id: randomUUID(), challenger_prediction_id: picks!.find((p) => p.user_id === D)!.id, recipient_prediction_id: picks!.find((p) => p.user_id === E)!.id, resolved_at: new Date().toISOString() });
    if (error) throw error;

    expect(await rpcRecord(D)).toEqual({ wins: 1, losses: 0, voids: 0 }); // still one
    expect(await rpcRecord(E)).toEqual({ wins: 0, losses: 1, voids: 0 });
    expect((await getHeadToHeadRecords(D, [E])).get(E)).toEqual({ wins: 1, losses: 0, voids: 0 });
    expect((await getHeadToHeadRecords(E, [D])).get(D)).toEqual({ wins: 0, losses: 1, voids: 0 });
    // The raw social history still lists both resolutions; only the counted record collapses.
    expect(await listCallBsHistory(D, 10)).toHaveLength(2);
  });
});

describe("recent history", () => {
  it("lists resolved challenges newest-resolved first, with opponent, Game, Market question, the user's own Pick, result and Post", async () => {
    const entries = await listCallBsHistory(A, 50);
    expect(entries.map((e) => e.challengeId)).toEqual([games.g5, games.g4, games.g3, games.g2, games.g1].map((g) => g.challengeId));

    const top = entries[0]; // g5: A beat C
    expect(top).toMatchObject({
      outcome: "WON",
      opponent: { id: C, label: `marco ${suffix}`, username: `cbhmarco${suffix}`, known: true },
      game: { label: `Five Away ${suffix} @ Five Home ${suffix}`, known: true },
      question: `Will Five Home ${suffix} win?`,
      marketLabel: "Moneyline",
      pickLabel: `Five Home ${suffix}`, // A's own snapshot (YES = the home team), as the Game reads it — not "YES", not "… win"
      opponentPickLabel: `Five Away ${suffix}`, // the opponent's snapshot (NO = the other team)
      postId: games.g5.postId,
    });
    expect(entries.find((e) => e.challengeId === games.g2.challengeId)!.outcome).toBe("LOST");
    expect(entries.find((e) => e.challengeId === games.g4.challengeId)!.outcome).toBe("VOID");
  });

  it("shows the recipient's own side for the recipient, and the mirrored result", async () => {
    const entries = await listCallBsHistory(B, 50);
    const g1 = entries.find((e) => e.challengeId === games.g1.challengeId)!;
    expect(g1.outcome).toBe("LOST");
    expect(g1.pickLabel).toBe(`One Away ${suffix}`); // B picked NO = the away team
    expect(g1.opponentPickLabel).toBe(`One Home ${suffix}`); // A picked YES = the home team
    expect(g1.opponent.id).toBe(A);
  });

  it("resolves opponents, Markets and Games in batches, not per row", async () => {
    const reads: string[] = [];
    const counting = {
      from: (table: string) => {
        reads.push(table);
        return admin.from(table as never);
      },
    };
    const entries = await listCallBsHistory(A, 50, counting as never);
    expect(entries).toHaveLength(5);
    expect(reads.sort()).toEqual(["challenges", "fixtures", "markets", "user_profiles"]); // one read each for 5 rows
  });

  it("is bounded by the limit and never includes unresolved challenges", async () => {
    expect(await listCallBsHistory(A, 2)).toHaveLength(2);
    const all = await listCallBsHistory(A, 100);
    expect(all).toHaveLength(5); // pending / declined / expired / accepted rows never appear
  });

  it("keeps a result understandable when the opponent is deactivated or the Game has no published Post", async () => {
    await admin.from("user_profiles").update({ is_active: false }).eq("id", C);
    try {
      const withoutC = (await listCallBsHistory(A, 50)).find((e) => e.challengeId === games.g5.challengeId)!;
      expect(withoutC.opponent).toMatchObject({ label: "Unavailable user", known: false, username: null });
      expect(withoutC.outcome).toBe("WON");
      expect(withoutC.resolvedAt).not.toBeNull();
    } finally {
      await admin.from("user_profiles").update({ is_active: true }).eq("id", C);
    }

    // The Game's Post is unpublished: the row has no Post to link to, but keeps the Game, opponent, result and date.
    await admin.from("posts").update({ published_at: null }).eq("id", games.g2.postId);
    try {
      const entry = (await listCallBsHistory(A, 50)).find((e) => e.challengeId === games.g2.challengeId)!;
      expect(entry.postId).toBeNull();
      expect(entry.opponent.label).toBe(`carlos ${suffix}`);
      expect(entry.outcome).toBe("LOST");
      expect(entry.resolvedAt).not.toBeNull();
    } finally {
      await admin.from("posts").update({ published_at: new Date().toISOString() }).eq("id", games.g2.postId);
    }
  });
});

describe("domain boundaries", () => {
  it("resolving Call BS never changes anyone's prediction accuracy or predicted count", async () => {
    const { data } = await admin.rpc("get_user_prediction_record", { p_user_id: A }).single();
    const record = data as { correct: number; incorrect: number; void: number; decided: number; accuracy: number | null };
    // A's Picks: g1 correct, g2 incorrect, g3 incorrect, g4 void, g5 correct (Picks only; accepted-but-ungraded Picks are not decided).
    expect({ correct: record.correct, incorrect: record.incorrect, void: record.void, decided: record.decided }).toEqual({ correct: 2, incorrect: 2, void: 1, decided: 4 });
    expect(Number(record.accuracy)).toBeCloseTo(0.5, 5);
  });

  it("reads no monetary data: a Position between the same two users on a Call BS Market adds nothing to the Call BS record", async () => {
    const before = await rpcRecord(A);
    const { data: positions } = await admin.from("monetary_positions").select("id").in("market_id", created.markets);
    expect(positions ?? []).toHaveLength(0); // none exist in this scenario, and the record has no money inputs by construction
    expect(await rpcRecord(A)).toEqual(before);
  });
});
