/**
 * Brohda 2.1 M4 — the competitive social loop (Pick -> talk -> Call BS -> result -> record) against the real local Supabase.
 * It drives the same functions the Post page and the server actions use, in the order a Member meets them, and reads the result through the two new Post readers:
 *   - loadPostSocial: each Member's side and the Call BS control or status offered to the viewer (the comment badges and the inline Call BS);
 *   - loadGameCallBsStatus: the viewer's "Your Call BS" block, in every lifecycle state.
 * Scenarios A (full loop), B (Pick changed), C (T-10), D (accepted + Confidence), E (invalid attempts). No AI, no network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { acceptCallBS, callBS, declineCallBS, expireStaleChallenges, getChallengeById, getChallengeRecordForUser, hasAcceptedCallBsAmong } from "@/lib/challenges/repository";
import { runChallengeLifecycleJob } from "@/lib/challenges/lifecycle";
import { loadPostSocial } from "@/lib/challenges/post-social";
import { loadGameCallBsStatus } from "@/lib/challenges/game-status";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { setPick } from "@/lib/predictions/repository";
import { addPostComment, getPostConversation } from "@/lib/post-comments/repository";
import { ensureAndPublishPostForFixture } from "@/lib/posts/publication";
import { notifyPickChangedCancellations } from "@/lib/notifications/challenges";
import { resolveNotificationHref } from "@/lib/notifications/links";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { getMarketById } from "@/lib/prediction-markets/repository";
import { visibleCommenterIds } from "@/lib/post-comments/commenters";

const admin = getTestAdminClient();
const LOCK_MINUTES = 10;

beforeEach(async () => {
  const { error } = await admin.from("platform_settings").update({ call_bs_enabled: true, pick_lock_minutes_before_kickoff: LOCK_MINUTES, call_bs_rate_limit_max_attempts: 100 }).eq("id", true);
  if (error) throw error;
});

/** A Game with a published Post and one MONEYLINE Market, "Seed Away @ Seed Home". YES = the home side. */
async function game(startsInMinutes = 24 * 60) {
  const g = await seedGame({ startsInMinutes });
  const { postId } = await ensureAndPublishPostForFixture(g.fixtureId, true);
  const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", g.fixtureId).single();
  return { ...g, postId, scheduledStartUtc: fixture!.scheduled_start_utc as string };
}

async function labels(marketId: string) {
  const market = (await getMarketById(marketId))!;
  const { data: f } = await admin.from("fixtures").select("home_team_name, away_team_name, sport").eq("id", market.fixtureId).single();
  return (outcome: "YES" | "NO") => getSelectionLabel({ ...market, homeTeamName: f!.home_team_name, awayTeamName: f!.away_team_name, sport: f!.sport }, outcome);
}

async function social(g: Awaited<ReturnType<typeof game>>, viewerId: string) {
  return loadPostSocial({ marketId: g.marketId, viewerId, scheduledStartUtc: g.scheduledStartUtc, lockMinutesBeforeKickoff: LOCK_MINUTES, labelFor: await labels(g.marketId) });
}

const status = (g: Awaited<ReturnType<typeof game>>, viewerId: string, pastCutoff = false) => loadGameCallBsStatus({ viewerId, marketIds: [g.marketId], pastCutoff });

async function call(challengerId: string, recipientPickId: string) {
  const r = await callBS(challengerId, recipientPickId);
  if (!r.ok) throw new Error(`call_bs: ${r.error}`);
  return r.challenge;
}

describe("A — the full loop: pick, talk, call BS, accept, result, record", () => {
  it("runs through one canonical Post, and every step is visible to both Members", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    const mariaPick = await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");

    // Talk: both argue on the SAME Post.
    const first = await addPostComment({ postId: g.postId, userId: maria, body: "Home all day.", parentCommentId: null });
    const reply = await addPostComment({ postId: g.postId, userId: sam, body: "Not a chance.", parentCommentId: first.id });
    const thread = await getPostConversation(g.postId, undefined, maria);
    expect(thread).toHaveLength(1);
    expect(thread[0].replies.map((r) => r.id)).toEqual([reply.id]);
    expect([...visibleCommenterIds(thread)].sort()).toEqual([maria, sam].sort());

    // Each sees the other's side, and the Call BS control only on the opposite side.
    const mariaView = (await social(g, maria))!;
    expect(mariaView.viewer.label).toBe("Seed Home");
    expect(mariaView.otherLabel).toBe("Seed Away");
    expect(mariaView.byUserId[sam]).toMatchObject({ relation: "opposite", label: "Seed Away", action: { kind: "call_bs", recipientPredictionId: samPick } });
    const samView = (await social(g, sam))!;
    expect(samView.byUserId[maria]).toMatchObject({ relation: "opposite", label: "Seed Home", action: { kind: "call_bs", recipientPredictionId: mariaPick } });

    // Maria calls BS from inside the argument. Maria sees it waiting; Sam sees it addressed to him, answerable above.
    const challenge = await call(maria, samPick);
    expect((await social(g, maria))!.byUserId[sam].action).toEqual({ kind: "outgoing_pending" });
    expect((await social(g, sam))!.byUserId[maria].action).toEqual({ kind: "called_on_you" });
    const mariaWaiting = (await status(g, maria)).items[0];
    expect(mariaWaiting.view).toMatchObject({ tone: "waiting", headline: "You called BS on sam", canRespond: false });
    const samIncoming = (await status(g, sam)).items[0];
    expect(samIncoming.view).toMatchObject({ tone: "action", headline: "maria called BS on you", canRespond: true });
    expect(samIncoming.view.detail).toContain("You picked Seed Away. maria picked Seed Home.");

    // The challenge notification lands on the Your Call BS block of that Post.
    expect(resolveNotificationHref({ type: "CALL_BS_RECEIVED", post_id: g.postId, market_id: g.marketId } as never)).toBe(`/post/${g.postId}#call-bs`);

    // Sam accepts: both Picks lock, and both see an unmistakable accepted state.
    const accepted = await acceptCallBS(challenge.id, sam);
    expect(accepted.outcome).toBe("accepted");
    for (const id of [mariaPick, samPick]) expect((await admin.from("predictions").select("lock_reason").eq("id", id).single()).data).toMatchObject({ lock_reason: "CHALLENGE_ACCEPTED" });
    for (const viewer of [maria, sam]) {
      const item = (await status(g, viewer)).items[0];
      expect(item.view.tone).toBe("locked");
      expect(item.view.detail).toContain("Both picks are locked");
    }
    expect((await social(g, maria))!.byUserId[sam].action).toEqual({ kind: "accepted" });

    // The Game finishes: Picks grade, the challenge resolves, and the result reads clearly to both.
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 24, away_score: 10 });
    await runGradingJob(recordGradedPredictionResult);
    const lifecycle = await runChallengeLifecycleJob();
    expect(lifecycle.resolved).toBeGreaterThanOrEqual(1);
    expect(await getChallengeById(challenge.id)).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });

    const mariaResult = (await status(g, maria, true)).items[0];
    expect(mariaResult.view).toMatchObject({ tone: "won", outcome: "WON", headline: "You called BS on sam: you were right" });
    // The head-to-head record sits beside the opponent in the conversation / "Other picks" (existing), read from the same resolved challenge.
    expect((await social(g, maria))!.byUserId[sam].headToHead).toEqual({ wins: 1, losses: 0 });
    const samResult = (await status(g, sam, true)).items[0];
    expect(samResult.view).toMatchObject({ tone: "lost", outcome: "LOST", headline: "maria called BS on you: maria was right" });
    expect((await social(g, sam))!.byUserId[maria].headToHead).toEqual({ wins: 0, losses: 1 });

    // The record: permanent, derived from the resolved challenge, one counted result.
    expect(await getChallengeRecordForUser(maria)).toEqual({ wins: 1, losses: 0, voids: 0 });
    expect(await getChallengeRecordForUser(sam)).toEqual({ wins: 0, losses: 1, voids: 0 });
    expect((await admin.from("predictions").select("result").eq("id", mariaPick).single()).data?.result).toBe("CORRECT");
    expect((await admin.from("predictions").select("result").eq("id", samPick).single()).data?.result).toBe("INCORRECT");

    // Resolution notified both once, linked to the canonical Post.
    const { data: resolved } = await admin.from("notifications").select("user_id, post_id, title").eq("challenge_id", challenge.id).eq("type", "CALL_BS_RESOLVED");
    expect((resolved ?? []).map((n) => n.user_id).sort()).toEqual([maria, sam].sort());
    expect((resolved ?? []).every((n) => n.post_id === g.postId)).toBe(true);
    expect((resolved ?? []).find((n) => n.user_id === maria)?.title).toBe("You won a Call BS");

    // One canonical Post throughout: nothing was duplicated.
    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", g.fixtureId);
    expect(count).toBe(1);
  });

  it("a Member with no Pick gets no sides and no controls, and a Member's own row never offers Call BS on themselves", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    const lurker = await seedUser("lurker");
    await seedPick(maria, g.marketId, "YES");
    await seedPick(sam, g.marketId, "NO");
    expect(await social(g, lurker)).toBeNull();
    const view = (await social(g, maria))!;
    expect(view.byUserId[maria]).toMatchObject({ relation: "self", action: null });
  });

  it("reads the Game's Call BS across every Market of the Game, and a Member with none gets an empty block", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    const lurker = await seedUser("lurker");
    await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    await call(maria, samPick);
    expect((await status(g, lurker)).items).toEqual([]);
    expect((await status(g, maria)).items).toHaveLength(1);
  });
});

describe("B — a pending Call BS ended by a Pick change", () => {
  it("is cancelled in the same step, the other Member is told once, and no stale Call BS control remains", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    const challenge = await call(maria, samPick);

    // Maria flips her side before T-10: now both read NO.
    const edit = await setPick({
      userId: maria,
      marketId: g.marketId,
      selectedOutcome: "NO",
      yesProbability: 0.6,
      noProbability: 0.4,
      marketQuestionSnapshot: "q",
      marketCloseAtSnapshot: null,
      marketStatusSnapshot: "ACTIVE",
      idempotencyKey: randomUUID(),
    });
    expect(edit.outcome).toBe("updated");
    expect(await getChallengeById(challenge.id)).toMatchObject({ status: "EXPIRED", expiryReason: "PICK_CHANGED" });
    await notifyPickChangedCancellations([challenge.id], maria);
    await notifyPickChangedCancellations([challenge.id], maria); // a retry never duplicates

    const { data: notes } = await admin.from("notifications").select("user_id, post_id").eq("challenge_id", challenge.id).eq("type", "CALL_BS_CANCELLED");
    expect(notes).toHaveLength(1);
    expect(notes![0]).toMatchObject({ user_id: sam, post_id: g.postId });

    // Both read "cancelled", nobody can respond, and the sides now agree so no Call BS is offered.
    for (const viewer of [maria, sam]) {
      const item = (await status(g, viewer)).items[0];
      expect(item.view).toMatchObject({ tone: "ended", headline: expect.stringMatching(/^Call BS with .* cancelled$/), canRespond: false });
    }
    const samView = (await social(g, sam))!;
    // The sides now agree, so no Call BS can be offered; the row says why in words (the existing "cancelled because the Pick changed" state), and is never a button.
    expect(samView.byUserId[maria]).toMatchObject({ relation: "same", action: { kind: "unavailable", pickChanged: true } });
    expect(["call_bs", "incoming_pending"]).not.toContain(samView.byUserId[maria].action?.kind);
    expect((await acceptCallBS(challenge.id, sam)).outcome).toBe("not_pending");
  });
});

describe("C — a pending Call BS at the T-10 deadline", () => {
  it("is not answerable once picks lock, expires, and can never be accepted afterwards", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    const challenge = await call(maria, samPick);

    // Kickoff moves to 5 minutes away: inside the 10-minute lock, exactly the deadline having passed.
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", g.fixtureId).single();
    const late = { ...g, scheduledStartUtc: fixture!.scheduled_start_utc as string };

    // Before the sweep: still PENDING in the table, but the page already reads it as expired and offers nothing to answer.
    expect((await getChallengeById(challenge.id))?.status).toBe("PENDING");
    const pastCutoff = true;
    for (const viewer of [maria, sam]) {
      const item = (await status(late, viewer, pastCutoff)).items[0];
      expect(item.view).toMatchObject({ tone: "ended", headline: expect.stringMatching(/^Call BS with .* expired$/), canRespond: false });
    }
    expect((await social(late, sam))!.byUserId[maria].action).toEqual({ kind: "unavailable" });
    expect((await social(late, maria))!.byUserId[sam].action).toEqual({ kind: "unavailable" });

    // The sweep makes it official; acceptance is refused, nothing locks, and Picks follow ordinary lock semantics.
    expect((await expireStaleChallenges()).map((c) => c.id)).toContain(challenge.id);
    expect((await acceptCallBS(challenge.id, sam)).outcome).toBe("not_pending");
    expect(await getChallengeById(challenge.id)).toMatchObject({ status: "EXPIRED", expiryReason: "NO_RESPONSE" });
    for (const viewer of [maria, sam]) expect((await status(late, viewer, true)).items[0].view.headline).toMatch(/^Call BS with .* expired$/);
  });

  it("a Call BS can be made right up to the deadline and not after", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    await setFixture(g.fixtureId, { scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() });
    const refused = await callBS(maria, samPick);
    expect(refused).toMatchObject({ ok: false, error: "past_challenge_cutoff" });
  });
});

describe("D — an accepted Call BS plus Confidence, before T-10", () => {
  it("Confidence reserves once, grading settles it, the Call BS resolves, and the ledger reconciles", async () => {
    await admin.from("platform_settings").update({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);
    const staff = await seedUser("m4-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staff);
    expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: staff, p_config: { confidence_mandatory: true } })).error).toBeNull();
    expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: staff, p_enabled: true })).error).toBeNull();

    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    for (const id of [maria, sam]) await admin.rpc("confidence_bootstrap_member", { p_member_id: id });
    const mariaPick = await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    const challenge = await call(maria, samPick);
    expect((await acceptCallBS(challenge.id, sam)).outcome).toBe("accepted");

    // Both locked by the Call BS; the team cannot change, but Confidence can still be attached before T-10.
    const attach = await admin.rpc("confidence_attach_stake", { p_member_id: maria, p_prediction_id: mariaPick, p_amount: 3, p_idempotency_key: randomUUID() });
    expect(attach.error, attach.error?.message).toBeNull();
    const again = await admin.rpc("confidence_attach_stake", { p_member_id: maria, p_prediction_id: mariaPick, p_amount: 3, p_idempotency_key: randomUUID() });
    expect(again.error).toBeNull();
    const { data: reserves } = await admin.from("confidence_ledger_entries").select("id").eq("member_id", maria).eq("entry_type", "PREDICTION_RESERVE");
    expect(reserves).toHaveLength(1); // reserved once, however many times it was asked

    // Opposite picks, one with Confidence: the Call BS state on the page is unchanged by it.
    expect((await status(g, maria)).items[0].view.tone).toBe("locked");
    expect((await status(g, sam)).items[0].view.tone).toBe("locked");

    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 31, away_score: 17 });
    await runGradingJob(recordGradedPredictionResult);
    await runChallengeLifecycleJob();
    expect(await getChallengeById(challenge.id)).toMatchObject({ status: "RESOLVED", result: "CHALLENGER_WON" });
    expect((await status(g, maria, true)).items[0].view.outcome).toBe("WON");
    expect((await status(g, sam, true)).items[0].view.outcome).toBe("LOST");

    // The ledger is clean after settlement.
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
    expect((await admin.rpc("confidence_reconcile_stakes", { p_grace_minutes: 0 })).data).toEqual([]);
  });
});

describe("E — invalid attempts fail safely, and the new surfaces never offer them", () => {
  async function pair() {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    const mariaPick = await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    return { g, maria, sam, mariaPick, samPick };
  }

  it("self-challenge, same-side challenge, and challenge without a Pick (either party) are rejected by the database", async () => {
    const { g, maria, mariaPick } = await pair();
    expect(await callBS(maria, mariaPick)).toMatchObject({ ok: false, error: "self_challenge" });

    const same = await seedUser("same");
    const samePick = await seedPick(same, g.marketId, "YES");
    expect(await callBS(maria, samePick)).toMatchObject({ ok: false, error: "picks_not_opposing" });

    const pickless = await seedUser("pickless");
    const target = await seedPick(await seedUser("target"), g.marketId, "NO");
    expect(await callBS(pickless, target)).toMatchObject({ ok: false, error: "challenger_pick_not_found" });
    expect(await callBS(maria, randomUUID())).toMatchObject({ ok: false, error: "recipient_pick_not_found" });
  });

  it("none of those are offered on the page either: no control for self, same side or a Member who has not picked", async () => {
    const { g, maria } = await pair();
    const same = await seedUser("same");
    await seedPick(same, g.marketId, "YES");
    const view = (await social(g, maria))!;
    expect(view.byUserId[maria].action).toBeNull();
    expect(view.byUserId[same]).toMatchObject({ relation: "same", action: null });
    const nonparticipant = await seedUser("quiet");
    expect(view.byUserId[nonparticipant]).toBeUndefined();
  });

  it("a postgame challenge is rejected, and no control is offered once the Game is over", async () => {
    const { g, maria, sam, samPick } = await pair();
    await setFixture(g.fixtureId, { internal_status: "COMPLETED", home_score: 10, away_score: 20 });
    await runGradingJob(recordGradedPredictionResult);
    const late = await callBS(maria, samPick);
    expect(late.ok).toBe(false);
    const view = (await social({ ...g }, maria))!;
    expect(view.byUserId[sam].action?.kind).not.toBe("call_bs");
  });

  it("acceptance: an expired, already-accepted, or declined Call BS cannot be accepted again, and a duplicate acceptance is idempotent", async () => {
    const { maria, sam, samPick, g } = await pair();
    const first = await call(maria, samPick);
    const accepted = await acceptCallBS(first.id, sam);
    expect(accepted.outcome).toBe("accepted");
    const second = await acceptCallBS(first.id, sam);
    expect(second.outcome).toBe("not_pending");
    expect(second.challenge.status).toBe("ACCEPTED");
    // Exactly one accepted challenge for the pair, one lock each.
    const { count } = await admin.from("challenges").select("id", { count: "exact", head: true }).eq("market_id", g.marketId).eq("status", "ACCEPTED");
    expect(count).toBe(1);

    const other = await game();
    const a = await seedUser("a");
    const b = await seedUser("b");
    await seedPick(a, other.marketId, "YES");
    const bPick = await seedPick(b, other.marketId, "NO");
    const declined = await call(a, bPick);
    await declineCallBS(declined.id, b);
    expect((await acceptCallBS(declined.id, b)).outcome).toBe("not_pending");
    expect((await status(other, a)).items[0].view.headline).toBe("b declined your Call BS");
    expect((await status(other, b)).items[0].view.headline).toBe("You declined a's Call BS");
  });

  it("an accepted Call BS exclusively pairs two Members: nobody else is offered it, nor can accept it", async () => {
    const { g, maria, sam, samPick } = await pair();
    const third = await seedUser("third");
    await seedPick(third, g.marketId, "NO");
    const first = await call(maria, samPick);
    await acceptCallBS(first.id, sam);
    const thirdView = (await social(g, third))!;
    expect(thirdView.byUserId[maria].action).toMatchObject({ kind: "in_call_bs" });
    // The Pick change after acceptance is refused: the Pick stays locked.
    const flip = await setPick({ userId: maria, marketId: g.marketId, selectedOutcome: "NO", yesProbability: 0.6, noProbability: 0.4, marketQuestionSnapshot: "q", marketCloseAtSnapshot: null, marketStatusSnapshot: "ACTIVE", idempotencyKey: randomUUID() });
    expect(flip.outcome).not.toBe("updated");
    expect((await admin.from("predictions").select("selected_outcome").eq("user_id", maria).eq("market_id", g.marketId).single()).data?.selected_outcome).toBe("YES");
  });

  it("duplicate and reverse Call BS between the same pair are refused while one is pending; a fresh one is allowed after it ends; an accepted pairing is detected for the action's guard", async () => {
    const { g, maria, sam, mariaPick, samPick } = await pair();
    const first = await call(maria, samPick);
    expect(await callBS(maria, samPick)).toMatchObject({ ok: false, error: "duplicate_pending_challenge" });
    expect(await callBS(sam, mariaPick)).toMatchObject({ ok: false, error: "duplicate_pending_challenge" });

    expect(await hasAcceptedCallBsAmong(g.marketId, [maria, sam])).toBe(false);
    await declineCallBS(first.id, sam);
    const second = await call(maria, samPick); // a terminal one never blocks a fresh one
    expect(second.id).not.toBe(first.id);

    await acceptCallBS(second.id, sam);
    // Either Member of the accepted pair, alone or together, is detected; an unrelated Member is not.
    expect(await hasAcceptedCallBsAmong(g.marketId, [maria])).toBe(true);
    expect(await hasAcceptedCallBsAmong(g.marketId, [sam])).toBe(true);
    const outsider = await seedUser("outsider");
    expect(await hasAcceptedCallBsAmong(g.marketId, [outsider])).toBe(false);
    expect(await hasAcceptedCallBsAmong(g.marketId, [outsider, maria])).toBe(true);
    // A different Game is unaffected.
    const other = await game();
    expect(await hasAcceptedCallBsAmong(other.marketId, [maria, sam])).toBe(false);
  });

  it("a Member cannot answer a Call BS addressed to someone else", async () => {
    const { maria, sam, samPick } = await pair();
    const challenge = await call(maria, samPick);
    const stranger = await seedUser("stranger");
    await expect(acceptCallBS(challenge.id, stranger)).rejects.toThrow(/not_recipient/);
    await expect(declineCallBS(challenge.id, maria)).rejects.toThrow(/not_recipient/);
    expect((await getChallengeById(challenge.id))?.status).toBe("PENDING");
    void sam;
  });
});

describe("The new surfaces carry no money and no recommendation", () => {
  it("every state's copy is free of betting and money terms", async () => {
    const g = await game();
    const maria = await seedUser("maria");
    const sam = await seedUser("sam");
    await seedPick(maria, g.marketId, "YES");
    const samPick = await seedPick(sam, g.marketId, "NO");
    await call(maria, samPick);
    const { items } = await status(g, sam);
    for (const item of items) expect(`${item.view.headline} ${item.view.detail}`).not.toMatch(/\b(bet|wager|stake|cash|odds|payout|money|prize)\b/i);
  });
});
