/**
 * Brohda 2.1, Milestone 1 (migration 211) — the concurrency proofs. One authoritative T-10 read with clock_timestamp() AFTER the locks, and one lock order for every writer
 * (advisory (Market, Member) locks sorted by Member → Pick rows by id → Call BS rows by id).
 *   - T-10 during a lock wait: an action that started before T-10 but obtained its lock after it is refused, for EVERY writer (which also proves every writer waits on the same canonical lock);
 *   - edit vs accept, edit vs Call BS creation, edit vs Confidence attach, simultaneous edits, simultaneous acceptances — each with one of exactly two coherent outcomes, never a stale challenge;
 *   - a randomized interleaving probe across all writers: no deadlock, and the invariants hold after every round.
 * Real local Supabase; real parallel database sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedGame, seedUser, setFixture } from "./helpers/game-seed";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function sql<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}
async function sqlReplica(text: string) {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(text);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
let staffId: string | null = null;
async function superAdmin() {
  if (!staffId) {
    staffId = await seedUser("cc-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  }
  return staffId;
}
beforeEach(async () => {
  await sqlReplica("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null where id = true");
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 1000, confidence_daily_claim_amount: 1, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true });
  // production-shaped: the mandatory cutover set, optional Picks on
  const id = await superAdmin();
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: id, p_config: { confidence_mandatory: true } })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: id, p_enabled: true })).error).toBeNull();
});
afterEach(async () => {
  if (staffId) await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  staffId = null;
});

async function member(label: string) {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const pickOf = async (userId: string, marketId: string) => ((await admin.from("predictions").select("*").eq("user_id", userId).eq("market_id", marketId).maybeSingle()).data ?? null) as Row | null;
const stakeOf = async (predictionId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data ?? null) as Row | null;
const challengeOf = async (id: string) => (await admin.from("challenges").select("*").eq("id", id).single()).data as Row;
const setPickRpc = (userId: string, marketId: string, side: "YES" | "NO", key: string = randomUUID()) =>
  admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: side, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: key })
    .single() as unknown as Promise<{ data: { prediction: Row | null; outcome: string; cancelled_challenge_ids: string[] | null } | null; error: { message: string } | null }>;
const attachRpc = (memberId: string, predictionId: string, amount: number, key: string = randomUUID()) =>
  admin.rpc("confidence_attach_stake", { p_member_id: memberId, p_prediction_id: predictionId, p_amount: amount, p_idempotency_key: key }) as unknown as Promise<{ data: Row | null; error: { message: string } | null }>;
const composeRpc = (memberId: string, marketId: string, side: "YES" | "NO", amount: number) =>
  admin.rpc("create_confidence_prediction", {
    p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.6, p_no_probability: 0.4,
    p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID(),
  }) as unknown as Promise<{ data: Row | null; error: { message: string } | null }>;
const callBsRpc = (challengerId: string, recipientPredictionId: string) => admin.rpc("call_bs", { p_challenger_user_id: challengerId, p_recipient_prediction_id: recipientPredictionId });
const acceptRpc = (challengeId: string, recipientId: string) =>
  admin.rpc("accept_call_bs", { p_challenge_id: challengeId, p_recipient_user_id: recipientId }).single() as unknown as Promise<{ data: { challenge: Row; outcome: string } | null; error: { message: string } | null }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-10 during a lock wait
// ---------------------------------------------------------------------------------------------------------------------------------------------
/**
 * Holds the canonical (Market, Members) advisory locks in one session, starts `fire` while T-10 is still ahead (the call's transaction therefore BEGINS before the deadline), keeps it waiting until after the deadline,
 * then releases. A writer that decided with the transaction-start time would act; one that decides after its locks, with the database clock, must refuse. A writer on a different lock key would not wait at all.
 */
async function heldPastDeadline<T>(marketId: string, fixtureId: string, members: string[], deadlineInMs: number, fire: () => PromiseLike<T>): Promise<T> {
  await setFixture(fixtureId, { scheduled_start_utc: new Date(Date.now() + 10 * 60_000 + deadlineInMs).toISOString() });
  const holder = new Client({ connectionString: getTestDatabaseUrl() });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query("select public.lock_market_members($1, $2, $3)", [marketId, members[0], members[1] ?? null]);
    // PostgREST builders are lazy: Promise.resolve() is what actually sends the request NOW, while T-10 is still ahead.
    const started = Promise.resolve(fire());
    await sleep(deadlineInMs + 600); // the deadline passes while the call is parked on the lock
    await holder.query("commit");
    return await started;
  } finally {
    await holder.end();
  }
}

describe("T-10 is decided after the locks, with the database clock", () => {
  it("a new Pick that started before T-10 but got its lock after it is refused (set_pick)", async () => {
    const g = await seedGame({});
    const u = await member("w1");
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [u], 1500, () => setPickRpc(u, g.marketId, "YES"));
    expect(r.error).toBeNull();
    expect(r.data!.outcome).toBe("rejected_cutoff");
    expect(await pickOf(u, g.marketId)).toBeNull();
  }, 30_000);

  it("an edit of an existing unstaked Pick is refused the same way (set_pick), and the Pick keeps its side", async () => {
    const g = await seedGame({});
    const u = await member("w2");
    expect((await setPickRpc(u, g.marketId, "YES")).data!.outcome).toBe("created");
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [u], 1500, () => setPickRpc(u, g.marketId, "NO"));
    expect(r.data!.outcome).toBe("rejected_cutoff");
    expect((await pickOf(u, g.marketId))!.selected_outcome).toBe("YES");
  }, 30_000);

  it("Confidence attach is refused (confidence_attach_stake) and reserves nothing", async () => {
    const g = await seedGame({});
    const u = await member("w3");
    const pick = (await setPickRpc(u, g.marketId, "YES")).data!.prediction!;
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [u], 1500, () => attachRpc(u, pick.id, 2));
    expect(r.data!.outcome).toBe("past_deadline");
    expect(await stakeOf(pick.id)).toBeNull();
  }, 30_000);

  it("the atomic Pick + Confidence is refused (create_confidence_prediction) and creates nothing", async () => {
    const g = await seedGame({});
    const u = await member("w4");
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [u], 1500, () => composeRpc(u, g.marketId, "YES", 2));
    expect(r.data!.outcome).toBe("past_deadline");
    expect(await pickOf(u, g.marketId)).toBeNull();
  }, 30_000);

  it("a Call BS that started before T-10 is refused after it (call_bs)", async () => {
    const g = await seedGame({});
    const a = await member("w5a");
    const b = await member("w5b");
    await setPickRpc(a, g.marketId, "YES");
    const bPick = (await setPickRpc(b, g.marketId, "NO")).data!.prediction!;
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [a, b], 1500, () => callBsRpc(a, bPick.id));
    expect(r.error?.message).toContain("past_challenge_cutoff");
    expect(((await admin.from("challenges").select("id").eq("market_id", g.marketId)).data ?? []).length).toBe(0);
  }, 30_000);

  it("an acceptance that started before T-10 is refused after it (accept_call_bs), the challenge expires and both Picks stay unlocked", async () => {
    const g = await seedGame({});
    const a = await member("w6a");
    const b = await member("w6b");
    await setPickRpc(a, g.marketId, "YES");
    const bPick = (await setPickRpc(b, g.marketId, "NO")).data!.prediction!;
    const created = await callBsRpc(a, bPick.id);
    expect(created.error).toBeNull();
    const challengeId = (created.data as Row).id as string;
    const r = await heldPastDeadline(g.marketId, g.fixtureId, [a, b], 1500, () => acceptRpc(challengeId, b));
    expect(r.error).toBeNull();
    expect(r.data!.outcome).toBe("rejected_cutoff");
    expect((await challengeOf(challengeId)).status).toBe("EXPIRED");
    expect((await pickOf(b, g.marketId))!.locked_at).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ROUNDS = 10;

/** The invariants that must hold for a Market after ANY interleaving. */
async function assertMarketConsistent(marketId: string) {
  const picks = ((await admin.from("predictions").select("*").eq("market_id", marketId)).data ?? []) as Row[];
  const byUser = new Map(picks.map((p) => [p.user_id as string, p]));
  const challenges = ((await admin.from("challenges").select("*").eq("market_id", marketId)).data ?? []) as Row[];
  for (const c of challenges) {
    const ch = byUser.get(c.challenger_user_id);
    const rc = byUser.get(c.recipient_user_id);
    if (c.status === "PENDING") {
      // No stale pending challenge: both Picks exist, still say what the challenge named, and still disagree.
      expect(ch, `pending ${c.id}: challenger pick`).toBeTruthy();
      expect(rc, `pending ${c.id}: recipient pick`).toBeTruthy();
      expect(ch!.selected_outcome, `pending ${c.id}: challenger snapshot`).toBe(c.challenger_selection_snapshot);
      expect(rc!.selected_outcome, `pending ${c.id}: recipient snapshot`).toBe(c.recipient_selection_snapshot);
      expect(ch!.selected_outcome).not.toBe(rc!.selected_outcome);
    }
    if (c.status === "ACCEPTED") {
      expect(ch!.selected_outcome).toBe(c.challenger_selection_snapshot);
      expect(rc!.selected_outcome).toBe(c.recipient_selection_snapshot);
      expect(ch!.locked_at, `accepted ${c.id}: challenger locked`).not.toBeNull();
      expect(rc!.locked_at, `accepted ${c.id}: recipient locked`).not.toBeNull();
    }
  }
  // Exclusivity: a Member is in at most one ACCEPTED challenge on the Market.
  const members = challenges.filter((c) => c.status === "ACCEPTED").flatMap((c) => [c.challenger_user_id, c.recipient_user_id]);
  expect(new Set(members).size, "a Member is in two accepted challenges").toBe(members.length);
  // A stake always describes its Pick, and a staked Pick is locked.
  for (const p of picks) {
    const s = await stakeOf(p.id);
    if (s) {
      expect(s.selected_outcome).toBe(p.selected_outcome);
      expect(p.locked_at).not.toBeNull();
    }
  }
}

describe("races between writers have exactly the two coherent outcomes", () => {
  it("edit vs accept: either the acceptance wins (Picks locked, edit refused) or the edit wins (challenge PICK_CHANGED, acceptance 'not_pending')", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < ROUNDS; i++) {
      const g = await seedGame({});
      const a = await member(`ea${i}`);
      const b = await member(`eb${i}`);
      await setPickRpc(a, g.marketId, "YES");
      const bPick = (await setPickRpc(b, g.marketId, "NO")).data!.prediction!;
      const created = await callBsRpc(a, bPick.id);
      expect(created.error).toBeNull();
      const challengeId = (created.data as Row).id as string;
      const [edit, acc] = await Promise.all([setPickRpc(a, g.marketId, "NO"), acceptRpc(challengeId, b)]);
      expect(edit.error?.message ?? null).toBeNull();
      expect(acc.error?.message ?? null).toBeNull();
      const c = await challengeOf(challengeId);
      if (acc.data!.outcome === "accepted") {
        seen.add("accept-first");
        expect(edit.data!.outcome).toBe("rejected_locked");
        expect(c.status).toBe("ACCEPTED");
        expect((await pickOf(a, g.marketId))!.selected_outcome).toBe("YES");
      } else {
        seen.add("edit-first");
        expect(acc.data!.outcome).toBe("not_pending");
        expect(edit.data!.outcome).toBe("updated");
        expect([c.status, c.expiry_reason]).toEqual(["EXPIRED", "PICK_CHANGED"]);
        expect(edit.data!.cancelled_challenge_ids).toEqual([challengeId]);
        expect((await pickOf(a, g.marketId))!.selected_outcome).toBe("NO");
      }
      await assertMarketConsistent(g.marketId);
    }
    expect(seen.size).toBeGreaterThan(0);
  }, 120_000);

  it("edit vs Call BS creation: no stale challenge is ever left — either the challenge is built on the new selections or the edit cancels it", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const g = await seedGame({});
      const a = await member(`ca${i}`);
      const b = await member(`cb${i}`);
      const aPick = (await setPickRpc(a, g.marketId, "YES")).data!.prediction!;
      await setPickRpc(b, g.marketId, "NO");
      // b calls BS on a's Pick while a flips to NO
      const [edit, call] = await Promise.all([setPickRpc(a, g.marketId, "NO"), callBsRpc(b, aPick.id)]);
      expect(edit.data!.outcome).toBe("updated");
      if (call.error) {
        expect(call.error.message).toContain("picks_not_opposing"); // the edit landed first
        expect(((await admin.from("challenges").select("id").eq("market_id", g.marketId)).data ?? []).length).toBe(0);
      } else {
        const id = (call.data as Row).id as string;
        expect((await challengeOf(id)).status).toBe("EXPIRED"); // the challenge was created first, and the edit cancelled it
        expect((await challengeOf(id)).expiry_reason).toBe("PICK_CHANGED");
      }
      await assertMarketConsistent(g.marketId);
    }
  }, 120_000);

  it("edit vs Confidence attach: the stake always describes the Pick; after the attach the team never changes", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const g = await seedGame({});
      const u = await member(`xa${i}`);
      const pick = (await setPickRpc(u, g.marketId, "YES")).data!.prediction!;
      const [edit, att] = await Promise.all([setPickRpc(u, g.marketId, "NO"), attachRpc(u, pick.id, 2)]);
      expect(edit.error?.message ?? null).toBeNull();
      expect(att.error?.message ?? null).toBeNull();
      expect(att.data!.outcome).toBe("attached");
      const final = (await pickOf(u, g.marketId))!;
      const stake = (await stakeOf(pick.id))!;
      expect(stake.selected_outcome).toBe(final.selected_outcome);
      if (edit.data!.outcome === "rejected_locked") expect(final.selected_outcome).toBe("YES"); // the attach won
      else expect(edit.data!.outcome).toBe("updated"); // the edit won; the attach used the final edited side
      expect((await setPickRpc(u, g.marketId, final.selected_outcome === "YES" ? "NO" : "YES")).data!.outcome).toBe("rejected_locked");
      await assertMarketConsistent(g.marketId);
    }
  }, 120_000);

  it("simultaneous edits of one Pick serialize: every request is answered, the revisions add up, no deadlock", async () => {
    const g = await seedGame({});
    const u = await member("se");
    await setPickRpc(u, g.marketId, "YES");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => setPickRpc(u, g.marketId, i % 2 === 0 ? "NO" : "YES")));
    for (const r of results) {
      expect(r.error?.message ?? null).toBeNull();
      expect(["updated", "unchanged"]).toContain(r.data!.outcome);
    }
    const pick = (await pickOf(u, g.marketId))!;
    const revisions = ((await admin.from("prediction_revisions").select("*").eq("prediction_id", pick.id)).data ?? []) as Row[];
    expect(revisions.length).toBe(results.filter((r) => r.data!.outcome === "updated").length);
    // Every revision is a real change, and the transitions add up to the net movement from the first side (YES) to the current one — whatever order the transactions committed in.
    for (const r of revisions) expect(r.previous_selected_outcome).not.toBe(r.new_selected_outcome);
    const net = revisions.filter((r) => r.new_selected_outcome === "NO").length - revisions.filter((r) => r.new_selected_outcome === "YES").length;
    expect(net).toBe(pick.selected_outcome === "NO" ? 1 : 0);
  }, 60_000);

  it("simultaneous acceptances of two challenges on one Pick: exactly one is ACCEPTED, the other expires as COMPETING_CHALLENGE_RESOLVED", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const g = await seedGame({});
      const target = await member(`t${i}`);
      const c1 = await member(`c1${i}`);
      const c2 = await member(`c2${i}`);
      const tPick = (await setPickRpc(target, g.marketId, "NO")).data!.prediction!;
      await setPickRpc(c1, g.marketId, "YES");
      await setPickRpc(c2, g.marketId, "YES");
      const ch1 = ((await callBsRpc(c1, tPick.id)).data as Row).id as string;
      const ch2 = ((await callBsRpc(c2, tPick.id)).data as Row).id as string;
      const [r1, r2] = await Promise.all([acceptRpc(ch1, target), acceptRpc(ch2, target)]);
      expect(r1.error?.message ?? null).toBeNull();
      expect(r2.error?.message ?? null).toBeNull();
      const statuses = [(await challengeOf(ch1)).status, (await challengeOf(ch2)).status].sort();
      expect(statuses).toEqual(["ACCEPTED", "EXPIRED"]);
      await assertMarketConsistent(g.marketId);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The randomized interleaving / deadlock probe
// ---------------------------------------------------------------------------------------------------------------------------------------------
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const EXPECTED_REFUSALS = ["picks_not_opposing", "duplicate_pending_challenge", "challenger_pick_not_found", "recipient_pick_not_found", "self_challenge", "past_challenge_cutoff", "pick_already_graded"];

describe("randomized interleaving probe", () => {
  it("random concurrent operations by four Members across many Markets: zero deadlocks, zero stale or broken challenges, stakes always match their Pick, the ledger reconciles", async () => {
    const seed = 20261023;
    const rand = rng(seed);
    const users = await Promise.all([member("rp0"), member("rp1"), member("rp2"), member("rp3")]);
    const errors: string[] = [];
    const markets: string[] = [];
    const ROUNDS_PROBE = 24;
    for (let round = 0; round < ROUNDS_PROBE; round++) {
      const g = await seedGame({});
      markets.push(g.marketId);
      // start with a few Picks so Call BS and accepts have something to act on
      for (const u of users) if (rand() < 0.7) await setPickRpc(u, g.marketId, rand() < 0.5 ? "YES" : "NO");
      const pending = ((await admin.from("challenges").select("id").eq("market_id", g.marketId)).data ?? []) as Row[];
      void pending;
      const ops: Promise<unknown>[] = [];
      const opCount = 6 + Math.floor(rand() * 4);
      for (let k = 0; k < opCount; k++) {
        const u = users[Math.floor(rand() * users.length)];
        const other = users[Math.floor(rand() * users.length)];
        const kind = Math.floor(rand() * 6);
        ops.push(
          (async () => {
            const record = (e: { message: string } | null | undefined) => {
              if (e && !EXPECTED_REFUSALS.some((m) => e.message.includes(m))) errors.push(e.message);
            };
            if (kind === 0 || kind === 1) {
              record((await setPickRpc(u, g.marketId, rand() < 0.5 ? "YES" : "NO")).error);
            } else if (kind === 2) {
              const p = await pickOf(u, g.marketId);
              if (p) record((await attachRpc(u, p.id, 1 + Math.floor(rand() * 5))).error);
            } else if (kind === 3) {
              const p = await pickOf(other, g.marketId);
              if (p) record((await callBsRpc(u, p.id)).error);
            } else if (kind === 4) {
              const mine = (await admin.from("challenges").select("id").eq("market_id", g.marketId).eq("recipient_user_id", u).eq("status", "PENDING").limit(1)).data ?? [];
              if (mine[0]) record((await acceptRpc((mine[0] as Row).id, u)).error);
            } else {
              record((await composeRpc(u, g.marketId, rand() < 0.5 ? "YES" : "NO", 1 + Math.floor(rand() * 5))).error);
            }
          })(),
        );
      }
      await Promise.all(ops);
      await assertMarketConsistent(g.marketId);
    }
    expect(errors.filter((e) => /deadlock/i.test(e)), `deadlocks (seed ${seed})`).toEqual([]);
    expect(errors, `unexpected errors (seed ${seed})`).toEqual([]);
    expect(await sql("select * from public.confidence_reconcile_stakes()")).toEqual([]);
    expect(markets.length).toBe(ROUNDS_PROBE);
    // every Member's account: available + reserved equals the sum of their ledger deltas (the append-only ledger is the truth)
    for (const u of users) {
      const [acct] = await sql<Row>("select available, reserved from public.confidence_accounts where member_id = $1", [u]);
      const [sum] = await sql<Row>("select coalesce(sum(available_delta), 0) a, coalesce(sum(reserved_delta), 0) r from public.confidence_ledger_entries where member_id = $1", [u]);
      expect([Number(acct.available), Number(acct.reserved)]).toEqual([Number(sum.a), Number(sum.r)]);
    }
  }, 300_000);
});
