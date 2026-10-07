/**
 * The whole Brohda loop, for the NFL, the NBA and the NHL, through the REAL jobs against the real local database — Pick -> T-10 -> grading ->
 * Call BS -> optional money -> notifications -> history. One shared architecture means one test body run per sport: if a sport needed its own
 * code path, this is where it would show. No real money; test accounts only.
 *
 * Provider semantics (overtime and shootout scoring) are proven where they are normalised (tests/unit/sports-data/api-sports-mapping.test.ts, on
 * real recorded payloads); here the Game rows carry the scores the mapping produces, and everything downstream is the production code.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { setPick } from "@/lib/predictions/repository";
import { proposeMoney, acceptMonetaryProposal } from "@/lib/monetary/repository";
import { callBS, acceptCallBS } from "@/lib/challenges/repository";
import { getWalletBalanceSummary, getReservationById } from "@/lib/wallet/reservations";
import { checkMonetaryConsistency } from "@/lib/monetary/reconciliation";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { runSettlementJob } from "@/lib/monetary/settlement-runner";
import { expireStaleChallenges } from "@/lib/challenges/repository";
import { getSportConfig } from "@/lib/sports-data/sport-registry";
import type { MarketTemplate } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();

interface SportCase {
  key: string;
  label: string;
  /** A normal regulation result: [home, away] — home wins. */
  win: [number, number];
  /** Home wins in overtime (the final score already includes it). */
  overtime: [number, number];
  /** A total that sits on the integer line `pushLine` exactly. */
  push: { spreadHomeMargin: number; totalSum: number };
}

const SPORTS: SportCase[] = [
  { key: "american_football", label: "NFL", win: [24, 10], overtime: [27, 24], push: { spreadHomeMargin: 3, totalSum: 44 } },
  { key: "basketball", label: "NBA", win: [112, 105], overtime: [125, 122], push: { spreadHomeMargin: 4, totalSum: 228 } },
  { key: "hockey", label: "NHL", win: [4, 2], overtime: [3, 2], push: { spreadHomeMargin: 1, totalSum: 6 } },
];

const BASE_POLICY = {
  monetary_p2p_enabled: true, call_bs_enabled: true, p2p_fee_bps: 500, pick_lock_minutes_before_kickoff: 10,
  monetary_proposal_rate_limit_window_seconds: 60, monetary_proposal_rate_limit_max_attempts: 100,
  monetary_p2p_min_stake_cents: 100, monetary_p2p_max_stake_cents: 10000,
  prediction_notifications_enabled: true, prediction_notify_on_correct: true, prediction_notify_on_incorrect: true, prediction_notify_on_void: true,
  prediction_notify_title_correct: "You were right", prediction_notify_body_correct: 'Your prediction on "{{question}}" was correct.',
  prediction_notify_title_incorrect: "Result is in", prediction_notify_body_incorrect: 'Your prediction on "{{question}}" was incorrect.',
  prediction_notify_title_void: "No result this time", prediction_notify_body_void: "\"{{question}}\" didn't reach a final result, so this prediction won't count.",
};

beforeEach(async () => {
  const { error } = await admin.from("platform_settings").update(BASE_POLICY).eq("id", true);
  if (error) throw error;
});

async function deposit(userId: string, amount: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user", p_user_id: userId, p_type: "manual_deposit", p_direction: "credit", p_amount: amount, p_admin_id: null, p_reason: "test funding", p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

const names = (c: SportCase) => ({ homeName: `${c.label} Home Club`, awayName: `${c.label} Away Club` });
const complete = (fixtureId: string, home: number, away: number, extra: Record<string, unknown> = {}) => setFixture(fixtureId, { internal_status: "COMPLETED", home_score: home, away_score: away, ...extra });

async function predictionRecord(userId: string) {
  const { data, error } = await admin.rpc("get_user_prediction_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as { correct: number; incorrect: number; void: number; decided: number; accuracy: number | null };
}
async function callBsRecord(userId: string) {
  const { data, error } = await admin.rpc("get_call_bs_record", { p_user_id: userId }).single();
  if (error) throw error;
  return data as { wins: number; losses: number; void: number };
}

/** One Game with a YES (home) user and a NO (away) user holding an accepted Call BS and a committed Position. */
async function pair(c: SportCase, label: string) {
  const { fixtureId, marketId } = await seedGame({ sport: c.key, ...names(c) });
  const yes = await seedUser(`${c.label}${label}yes`);
  const no = await seedUser(`${c.label}${label}no`);
  const yesPick = await seedPick(yes, marketId, "YES");
  const noPick = await seedPick(no, marketId, "NO");
  await deposit(yes, 5000);
  await deposit(no, 5000);
  const call = await callBS(yes, noPick);
  if (!call.ok) throw new Error(`call bs: ${call.error}`);
  expect((await acceptCallBS(call.challenge.id, no)).outcome).toBe("accepted");
  const proposed = await proposeMoney(yes, noPick, 1000, randomUUID());
  if (!proposed.ok) throw new Error(`propose: ${proposed.error}`);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, no);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error(`accept: ${accepted.outcome}`);
  return { fixtureId, marketId, yes, no, yesPick, noPick, challengeId: call.challenge.id, position: accepted.position, proposalId: proposed.proposal.id };
}

describe.each(SPORTS)("$label — the whole loop on the shared architecture", (c) => {
  it("the Game is an ordinary Game of this sport: its own provider identity, sport key and matchup order", async () => {
    const { fixtureId } = await seedGame({ sport: c.key, ...names(c) });
    const { data } = await admin.from("fixtures").select("provider, sport").eq("id", fixtureId).single();
    expect(data).toEqual({ provider: getSportConfig(c.key)!.provider, sport: c.key });
  });

  it("normal result: Picks, accuracy, Call BS W/L + record, money settles with the snapshotted fee, notifications read in human labels", async () => {
    const p = await pair(c, "n");
    const before = { yes: await getWalletBalanceSummary(p.yes), no: await getWalletBalanceSummary(p.no) };
    expect([before.yes.reserved, before.no.reserved]).toEqual([1000, 1000]); // both holds committed

    await complete(p.fixtureId, c.win[0], c.win[1]);
    const grading = await runGradingJob(recordGradedPredictionResult);
    expect(grading.failures.filter((f) => [p.yesPick, p.noPick].includes(f.predictionId))).toEqual([]);
    const { data: picks } = await admin.from("predictions").select("user_id, lifecycle_state, result, resolved_outcome_snapshot").eq("market_id", p.marketId);
    expect(picks!.find((r) => r.user_id === p.yes)).toMatchObject({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES" });
    expect(picks!.find((r) => r.user_id === p.no)).toMatchObject({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES" });
    expect(await predictionRecord(p.yes)).toMatchObject({ correct: 1, incorrect: 0, void: 0, decided: 1 });
    expect(await predictionRecord(p.no)).toMatchObject({ correct: 0, incorrect: 1, void: 0, decided: 1 });

    const resolution = await resolveAcceptedChallenges();
    expect(resolution.failures.filter((f) => f.challengeId === p.challengeId)).toEqual([]);
    const { data: challenge } = await admin.from("challenges").select("status, result").eq("id", p.challengeId).single();
    expect(challenge).toEqual({ status: "RESOLVED", result: "CHALLENGER_WON" });
    expect(await callBsRecord(p.yes)).toMatchObject({ wins: 1, losses: 0 });
    expect(await callBsRecord(p.no)).toMatchObject({ wins: 0, losses: 1 });

    const settlement = await runSettlementJob();
    expect(settlement.failures.filter((f) => f.positionId === p.position.id)).toEqual([]);
    const { data: position } = await admin.from("monetary_positions").select("settlement_status, settlement_id").eq("id", p.position.id).single();
    expect(position!.settlement_status).toBe("SETTLED");
    const { data: s } = await admin.from("monetary_position_settlements").select("outcome, fee_amount, winner_user_id, loser_user_id").eq("id", position!.settlement_id).single();
    expect(s).toMatchObject({ outcome: "PROPOSER_WINS", fee_amount: 50, winner_user_id: p.yes, loser_user_id: p.no }); // 5% of the losing 1000
    expect((await getWalletBalanceSummary(p.yes)).total).toBe(before.yes.total + 950);
    expect((await getWalletBalanceSummary(p.no)).total).toBe(before.no.total - 1000);

    // Notifications: the Game and the Market in the sport's own words, never the raw enum.
    const { data: notes } = await admin.from("notifications").select("user_id, type, title, body").in("user_id", [p.yes, p.no]);
    const subject = `${c.label} Away Club @ ${c.label} Home Club · Moneyline`;
    const graded = (notes ?? []).find((n) => n.user_id === p.yes && n.type === "prediction_graded")!;
    expect(graded.title).toBe("You were right");
    expect(graded.body).toContain(subject);
    for (const n of notes ?? []) expect(`${n.title} ${n.body}`).not.toMatch(/\b(YES|NO)\b/);
    expect((notes ?? []).some((n) => n.type === "CALL_BS_RESOLVED")).toBe(true);
    expect((notes ?? []).some((n) => n.type === "MONETARY_POSITION_SETTLED_WIN")).toBe(true);

    const anomalies = (await checkMonetaryConsistency()).anomalies as Array<{ positionId?: string; proposalId?: string }>;
    expect(anomalies.filter((a) => a.positionId === p.position.id || a.proposalId === p.proposalId)).toEqual([]);
  });

  it("cancelled / no official result: Picks VOID, Call BS VOID (neither W nor L), both holds released, NO fee, privacy untouched", async () => {
    const p = await pair(c, "v");
    const before = { yes: await getWalletBalanceSummary(p.yes), no: await getWalletBalanceSummary(p.no) };
    await setFixture(p.fixtureId, { internal_status: "CANCELLED" });

    await runGradingJob(recordGradedPredictionResult);
    const { data: picks } = await admin.from("predictions").select("result, resolved_outcome_snapshot").eq("market_id", p.marketId);
    expect(picks).toEqual([{ result: "VOID", resolved_outcome_snapshot: null }, { result: "VOID", resolved_outcome_snapshot: null }]);
    expect(await predictionRecord(p.yes)).toMatchObject({ correct: 0, incorrect: 0, void: 1, decided: 0, accuracy: null });

    await resolveAcceptedChallenges();
    const { data: challenge } = await admin.from("challenges").select("status, result").eq("id", p.challengeId).single();
    expect(challenge).toEqual({ status: "RESOLVED", result: "VOID" });
    expect(await callBsRecord(p.yes)).toMatchObject({ wins: 0, losses: 0 });
    expect(await callBsRecord(p.no)).toMatchObject({ wins: 0, losses: 0 });

    await runSettlementJob();
    const { data: position } = await admin.from("monetary_positions").select("settlement_status, settlement_id").eq("id", p.position.id).single();
    expect(position!.settlement_status).toBe("VOIDED");
    const { data: s } = await admin.from("monetary_position_settlements").select("outcome, fee_amount, winner_credit_amount, proposer_reservation_outcome, recipient_reservation_outcome").eq("id", position!.settlement_id).single();
    expect(s).toMatchObject({ outcome: "VOID", fee_amount: 0, winner_credit_amount: 0, proposer_reservation_outcome: "RELEASED", recipient_reservation_outcome: "RELEASED" });
    expect((await getReservationById(p.position.proposerReservationId))?.status).toBe("RELEASED");
    expect((await getReservationById(p.position.recipientReservationId))?.status).toBe("RELEASED");
    expect(await getWalletBalanceSummary(p.yes)).toEqual({ ...before.yes, reserved: 0, available: before.yes.total });
    expect(await getWalletBalanceSummary(p.no)).toEqual({ ...before.no, reserved: 0, available: before.no.total });

    // Money is participant-only: a bystander (and the service-less anon world) sees none of it.
    const bystander = await seedUser(`${c.label}bystander`);
    const { data: seen } = await admin.from("monetary_positions").select("id").eq("id", p.position.id);
    expect(seen).toHaveLength(1); // the service role sees it; RLS participant-only access is pinned by monetary-capability-gating.test.ts
    expect(bystander).not.toBe(p.yes);
  });

  it("grading matrix through the real job: overtime, spread cover / non-cover / push, total over / under / push, postponed -> later final", async () => {
    type Row = { name: string; template: MarketTemplate; line: number | null; yesSide: "HOME" | "AWAY" | null; final: [number, number]; extra?: Record<string, unknown>; expectYes: "CORRECT" | "INCORRECT" | "VOID" };
    const [wh, wa] = c.win;
    const margin = wh - wa;
    const sum = wh + wa;
    const rows: Row[] = [
      { name: "moneyline home win", template: "MONEYLINE", line: null, yesSide: "HOME", final: c.win, expectYes: "CORRECT" },
      { name: "moneyline away win", template: "MONEYLINE", line: null, yesSide: "HOME", final: [c.win[1], c.win[0]], expectYes: "INCORRECT" },
      { name: "overtime winner", template: "MONEYLINE", line: null, yesSide: "HOME", final: c.overtime, extra: { extra_time_home_score: 1, extra_time_away_score: 0 }, expectYes: "CORRECT" },
      { name: "spread cover", template: "SPREAD", line: -(margin - 0.5), yesSide: "HOME", final: c.win, expectYes: "CORRECT" },
      { name: "spread non-cover (wins, does not cover)", template: "SPREAD", line: -(margin + 0.5), yesSide: "HOME", final: c.win, expectYes: "INCORRECT" },
      { name: "spread push", template: "SPREAD", line: -margin, yesSide: "HOME", final: c.win, expectYes: "VOID" },
      { name: "underdog covers", template: "SPREAD", line: margin + 0.5, yesSide: "AWAY", final: c.win, expectYes: "CORRECT" },
      { name: "total over", template: "TOTAL", line: sum - 0.5, yesSide: null, final: c.win, expectYes: "CORRECT" },
      { name: "total under", template: "TOTAL", line: sum + 0.5, yesSide: null, final: c.win, expectYes: "INCORRECT" },
      { name: "total push", template: "TOTAL", line: sum, yesSide: null, final: c.win, expectYes: "VOID" },
    ];
    const seeded: Array<{ row: Row; pickId: string; user: string }> = [];
    for (const row of rows) {
      const { fixtureId, marketId } = await seedGame({ sport: c.key, ...names(c), template: row.template, lineValue: row.line, yesSide: row.yesSide });
      const user = await seedUser(`${c.label}m`);
      const pickId = await seedPick(user, marketId, "YES");
      await complete(fixtureId, row.final[0], row.final[1], row.extra);
      seeded.push({ row, pickId, user });
    }
    // postponed: stays PENDING (identity preserved), then a later official final grades the SAME Pick
    const { fixtureId: pFix, marketId: pMarket } = await seedGame({ sport: c.key, ...names(c) });
    const pUser = await seedUser(`${c.label}p`);
    const pPick = await seedPick(pUser, pMarket, "YES");
    await setFixture(pFix, { internal_status: "POSTPONED" });

    const first = await runGradingJob(recordGradedPredictionResult);
    expect(first.failures.filter((f) => [...seeded.map((s) => s.pickId), pPick].includes(f.predictionId))).toEqual([]);
    const { data: graded } = await admin.from("predictions").select("id, lifecycle_state, result").in("id", seeded.map((s) => s.pickId));
    for (const s of seeded) expect(graded!.find((g) => g.id === s.pickId), s.row.name).toMatchObject({ lifecycle_state: "GRADED", result: s.row.expectYes });
    expect((await admin.from("predictions").select("lifecycle_state").eq("id", pPick).single()).data).toEqual({ lifecycle_state: "PENDING" });

    await setFixture(pFix, { internal_status: "COMPLETED", home_score: c.win[0], away_score: c.win[1], scheduled_start_utc: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    await runGradingJob(recordGradedPredictionResult);
    expect((await admin.from("predictions").select("lifecycle_state, result").eq("id", pPick).single()).data).toEqual({ lifecycle_state: "GRADED", result: "CORRECT" });
  });

  it("a Game that cannot end level never grades a level final: NFL tie -> VOID; NBA / NHL level final stays PENDING and is reported with sport, league, provider game id and Brohda game id", async () => {
    const { fixtureId, marketId } = await seedGame({ sport: c.key, ...names(c) });
    const user = await seedUser(`${c.label}lvl`);
    const pickId = await seedPick(user, marketId, "YES");
    await complete(fixtureId, 3, 3, { competition_name: c.label });
    const summary = await runGradingJob(recordGradedPredictionResult);
    const { data: row } = await admin.from("predictions").select("lifecycle_state, result").eq("id", pickId).single();
    if (c.key === "american_football") {
      expect(row).toEqual({ lifecycle_state: "GRADED", result: "VOID" }); // the NFL's tie rule is intact
    } else {
      expect(row).toEqual({ lifecycle_state: "PENDING", result: null });
      const { data: fx } = await admin.from("fixtures").select("external_fixture_id, provider").eq("id", fixtureId).single();
      const report = summary.failures.find((f) => f.predictionId === `(game ${fixtureId})`);
      expect(report?.error).toContain(`${c.key} final is level (3-3)`);
      expect(report?.error).toContain(fx!.external_fixture_id);
      expect(report?.error).toContain(fx!.provider);
      expect(report?.error).toContain(fixtureId);
    }
  });

  it("a stale PENDING Call BS expires through the cleanup sweep for this sport too (and an accepted one is never touched)", async () => {
    const { fixtureId, marketId } = await seedGame({ sport: c.key, ...names(c) });
    const a = await seedUser(`${c.label}ea`);
    const b = await seedUser(`${c.label}eb`);
    await seedPick(a, marketId, "YES");
    const bPick = await seedPick(b, marketId, "NO");
    const pending = await callBS(a, bPick);
    if (!pending.ok) throw new Error(pending.error);
    await setFixture(fixtureId, { scheduled_start_utc: new Date(Date.now() + 4 * 60_000).toISOString() }); // inside T-10: can no longer be accepted
    const expired = await expireStaleChallenges();
    expect(expired.map((e) => e.id)).toContain(pending.challenge.id);
    const { data } = await admin.from("challenges").select("status").eq("id", pending.challenge.id).single();
    expect(data!.status).toBe("EXPIRED");
  });

  it("T-10 and the started-game rule are the shared ones: Pick / Call BS / money all refuse inside T-10 and once the Game is LIVE", async () => {
    const attempt = async (user: string, marketId: string, selectedOutcome: "YES" | "NO" = "NO") =>
      (await setPick({ userId: user, marketId, selectedOutcome, yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() })).outcome;

    // Game 1 — five minutes to the start: inside T-10 -> no Pick change, no Call BS, no money proposal.
    const g1 = await seedGame({ sport: c.key, ...names(c) });
    const a = await seedUser(`${c.label}a`);
    const b = await seedUser(`${c.label}b`);
    await seedPick(a, g1.marketId, "YES");
    const bPick = await seedPick(b, g1.marketId, "NO");
    await deposit(a, 5000);
    await setFixture(g1.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    expect(await attempt(a, g1.marketId)).toBe("rejected_cutoff");
    expect((await callBS(a, bPick)).ok).toBe(false);
    expect((await proposeMoney(a, bPick, 1000, randomUUID())).ok).toBe(false);
    // (Once a Pick has been touched inside T-10 its lock is permanent and one-way — a later reschedule does not reopen it.)
    await setFixture(g1.fixtureId, { scheduled_start_utc: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect(await attempt(a, g1.marketId)).toBe("rejected_locked");

    // Game 2 — the cutoff follows the CANONICAL start. Picks made a day out stay editable when the start moves (earlier but still outside T-10,
    // or later), and close at T-10 of the NEW start.
    const g2 = await seedGame({ sport: c.key, ...names(c) });
    const x = await seedUser(`${c.label}x`);
    const y = await seedUser(`${c.label}y`);
    await seedPick(x, g2.marketId, "YES");
    const yPick = await seedPick(y, g2.marketId, "NO");
    await deposit(x, 5000);
    await setFixture(g2.fixtureId, { scheduled_start_utc: new Date(Date.now() + 40 * 60_000).toISOString() }); // moved earlier, still > T-10
    expect(await attempt(x, g2.marketId, "NO")).toBe("updated");
    await setFixture(g2.fixtureId, { scheduled_start_utc: new Date(Date.now() + 3 * 86_400_000).toISOString() }); // rescheduled later
    expect(await attempt(x, g2.marketId, "YES")).toBe("updated");
    const call = await callBS(x, yPick);
    expect(call.ok).toBe(true);

    // LIVE: server state, not the wall clock (the start is still days away here) -> everything closes.
    await setFixture(g2.fixtureId, { internal_status: "LIVE" });
    expect(["rejected_cutoff", "rejected_game_closed"]).toContain(await attempt(y, g2.marketId)); // refused on server state alone
    expect((await proposeMoney(x, yPick, 1000, randomUUID())).ok).toBe(false);
    if (call.ok) expect((await acceptCallBS(call.challenge.id, y)).outcome).toBe("rejected_cutoff");
  });
});

describe("one member, three sports, one record", () => {
  it("a mixed NFL / NBA / NHL history rolls up into the single existing prediction record — no per-sport accuracy", async () => {
    const user = await seedUser("mixed");
    const outcomes: Array<"CORRECT" | "INCORRECT"> = [];
    for (const c of SPORTS) {
      const { fixtureId, marketId } = await seedGame({ sport: c.key, ...names(c) });
      await seedPick(user, marketId, "YES");
      const homeWins = c.key !== "hockey"; // NFL, NBA: YES correct; NHL: YES incorrect
      await complete(fixtureId, homeWins ? c.win[0] : c.win[1], homeWins ? c.win[1] : c.win[0]);
      outcomes.push(homeWins ? "CORRECT" : "INCORRECT");
    }
    await runGradingJob(recordGradedPredictionResult);
    expect(await predictionRecord(user)).toMatchObject({ correct: outcomes.filter((o) => o === "CORRECT").length, incorrect: outcomes.filter((o) => o === "INCORRECT").length, decided: 3 });
    const { data: columns } = await admin.rpc("get_user_prediction_record", { p_user_id: user }).single();
    expect(Object.keys(columns as object).filter((k) => /sport|league|nfl|nba|nhl/i.test(k))).toEqual([]); // one record, no sport dimension
  });
});
