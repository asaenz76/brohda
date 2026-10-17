/**
 * The authenticated shell's Confidence summary is ONE read of the Member's own `confidence_accounts` row through RLS (what getShellConfidence runs): total, available, reserved. This pins what that read returns through the whole
 * life of a prediction — commit, correct, incorrect, void, Daily Claim — and that it returns nothing (so the shell shows nothing, leaves no gap) while Confidence is off, for a Sponsor, and for anyone else's row.
 * Real local Supabase; no schema or accounting is touched here, this only reads what the shell shows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser, setFixture } from "./helpers/game-seed";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
beforeEach(async () => {
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24, pick_lock_minutes_before_kickoff: 10 });
});
afterEach(async () => {
  await setSettings({ confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5] });
});

async function member(label: string) {
  const id = await seedUser(label);
  await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
  return c;
}
/** Exactly the shell's read: the signed-in Member's own account through RLS. */
async function shellFigures(userId: string, client?: Awaited<ReturnType<typeof clientFor>>) {
  const c = client ?? (await clientFor(userId));
  const { data } = await c.from("confidence_accounts").select("available, reserved, total").eq("member_id", userId).maybeSingle();
  return data ? { total: Number(data.total), available: Number(data.available), reserved: Number(data.reserved) } : null;
}
const compose = async (memberId: string, marketId: string, side: "YES" | "NO", amount: number) =>
  (await admin.rpc("create_confidence_prediction", {
    p_user_id: memberId, p_market_id: marketId, p_selected_outcome: side, p_amount: amount, p_yes_probability: 0.6, p_no_probability: 0.4,
    p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID(),
  })) as { data: Row | null; error: { message: string } | null };
const settleWith = async (fixtureId: string, home: number, away: number) => {
  await setFixture(fixtureId, { internal_status: "COMPLETED", home_score: home, away_score: away });
  await runGradingJob(recordGradedPredictionResult);
};

describe("what the shell summary shows through a prediction's life", () => {
  it("A/B/D — a new Member, then a committed 🔥5: total unchanged, available down, reserved up; and the three always add up", async () => {
    const m = await member("shell-commit");
    expect(await shellFigures(m)).toEqual({ total: 50, available: 50, reserved: 0 });
    const g = await seedGame({ startsInMinutes: 24 * 60 });
    expect((await compose(m, g.marketId, "YES", 5)).data?.outcome).toBe("created");
    const f = (await shellFigures(m))!;
    expect(f).toEqual({ total: 50, available: 45, reserved: 5 });
    expect(f.total).toBe(f.available + f.reserved);
  });

  it("B — the example in the spec: 🔥50 total, 🔥32 available, 🔥18 reserved", async () => {
    const m = await member("shell-18");
    await setSettings({ confidence_allowed_stakes: [18] });
    const g = await seedGame({ startsInMinutes: 24 * 60 });
    expect((await compose(m, g.marketId, "YES", 18)).data?.outcome).toBe("created");
    expect(await shellFigures(m)).toEqual({ total: 50, available: 32, reserved: 18 });
  });

  it("C — nothing available: 🔥18 total, 🔥0 available, 🔥18 reserved (a real state, shown as it is)", async () => {
    await setSettings({ confidence_baseline: 18, confidence_allowed_stakes: [18] });
    const m = await member("shell-zero");
    const g = await seedGame({ startsInMinutes: 24 * 60 });
    expect(await shellFigures(m)).toEqual({ total: 18, available: 18, reserved: 0 });
    expect((await compose(m, g.marketId, "YES", 18)).data?.outcome).toBe("created");
    expect(await shellFigures(m)).toEqual({ total: 18, available: 0, reserved: 18 });
  });

  it("E/F/G — correct settlement: total +N and reserved back to 0; incorrect: total −N; void: total unchanged", async () => {
    const win = await member("shell-win");
    const loss = await member("shell-loss");
    const tie = await member("shell-void");
    const g = await seedGame({ startsInMinutes: 60 });
    await compose(win, g.marketId, "YES", 4);
    await compose(loss, g.marketId, "NO", 2);
    const g2 = await seedGame({ startsInMinutes: 60 });
    await compose(tie, g2.marketId, "YES", 3);
    expect(await shellFigures(win)).toEqual({ total: 50, available: 46, reserved: 4 });
    expect(await shellFigures(loss)).toEqual({ total: 50, available: 48, reserved: 2 });
    expect(await shellFigures(tie)).toEqual({ total: 50, available: 47, reserved: 3 });
    await settleWith(g.fixtureId, 7, 3); // home wins
    await settleWith(g2.fixtureId, 2, 2); // a tie: the Moneyline voids
    expect(await shellFigures(win)).toEqual({ total: 54, available: 54, reserved: 0 });
    expect(await shellFigures(loss)).toEqual({ total: 48, available: 48, reserved: 0 });
    expect(await shellFigures(tie)).toEqual({ total: 50, available: 50, reserved: 0 });
  });

  it("H — a Daily Claim is reflected in the very next read (total and available up, reserved untouched)", async () => {
    await setSettings({ confidence_baseline: 10, confidence_allowed_stakes: [5] });
    const m = await member("shell-claim");
    const g = await seedGame({ startsInMinutes: 60 });
    await compose(m, g.marketId, "NO", 5);
    await settleWith(g.fixtureId, 7, 3); // loses 5: total 5, below the baseline of 10
    expect(await shellFigures(m)).toEqual({ total: 5, available: 5, reserved: 0 });
    const claim = await admin.rpc("confidence_daily_claim", { p_member_id: m, p_idempotency_key: randomUUID() });
    expect(claim.error).toBeNull();
    expect(await shellFigures(m)).toEqual({ total: 6, available: 6, reserved: 0 });
  });
});

describe("who sees nothing", () => {
  it("K — with Confidence off the read returns nothing (no stale figures, no empty space), and returns again when it is on", async () => {
    const m = await member("shell-off");
    const c = await clientFor(m);
    expect(await shellFigures(m, c)).not.toBeNull();
    await setSettings({ confidence_enabled: false });
    expect(await shellFigures(m, c)).toBeNull();
    await setSettings({ confidence_enabled: true });
    expect(await shellFigures(m, c)).not.toBeNull();
  });

  it("I/J — a Sponsor has no Confidence account to read, and a Member can read nobody else's", async () => {
    const sponsor = await seedSponsorAccount("shell-sponsor");
    const sc = await clientFor(sponsor.userId);
    expect(await shellFigures(sponsor.userId, sc)).toBeNull();
    const a = await member("shell-a");
    const b = await member("shell-b");
    const ca = await clientFor(a);
    expect(await shellFigures(b, ca)).toBeNull();
    expect(await shellFigures(a, ca)).not.toBeNull();
    // Signed out: the anonymous role can read no account at all.
    const anon = getTestAnonClient();
    expect((await anon.from("confidence_accounts").select("total").eq("member_id", a)).data ?? []).toEqual([]);
  });
});
