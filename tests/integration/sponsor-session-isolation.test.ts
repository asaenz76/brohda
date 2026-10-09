/**
 * A real Sponsor SESSION against the real Member server actions and the real guards: every social/monetary action refuses a Sponsor (it is sent to the
 * Sponsor area), a Member keeps working, and nothing is written under the Sponsor's identity. The Next request context is the only thing faked (the cookie
 * jar is replaced by an authenticated client; redirect() throws as it does at runtime).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser } from "./helpers/game-seed";

const PASSWORD = "integration-test-password-123";
const admin = getTestAdminClient();

const state: { client: SupabaseClient | null } = { client: null };
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-brohda-request-path": "/feed" }), cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

async function signedIn(email: string) {
  const c = getTestAnonClient();
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  expect(error).toBeNull();
  return c;
}
const redirects = async (run: () => Promise<unknown>) => run().then(() => null, (e: Error) => e.message);

let predictions: typeof import("@/lib/actions/predictions");
let comments: typeof import("@/lib/actions/post-comments");
let challenges: typeof import("@/lib/actions/challenges");
let money: typeof import("@/lib/actions/monetary-proposals");
let follows: typeof import("@/lib/actions/follows");
let notifications: typeof import("@/lib/actions/notifications");
let walletRequests: typeof import("@/lib/actions/wallet-requests");
let profile: typeof import("@/lib/actions/profile");

beforeAll(async () => {
  predictions = await import("@/lib/actions/predictions");
  comments = await import("@/lib/actions/post-comments");
  challenges = await import("@/lib/actions/challenges");
  money = await import("@/lib/actions/monetary-proposals");
  follows = await import("@/lib/actions/follows");
  notifications = await import("@/lib/actions/notifications");
  walletRequests = await import("@/lib/actions/wallet-requests");
  profile = await import("@/lib/actions/profile");
});
afterAll(() => {
  state.client = null;
});

describe("a Sponsor session cannot use any Member action", () => {
  it("every Member action sends the Sponsor to /sponsor and writes nothing", async () => {
    const sponsor = await seedSponsorAccount("sessiso");
    const { fixtureId, marketId } = await seedGame({});
    const target = await seedUser("sessiso-target");
    const targetPick = await seedPick(target, marketId, "YES");
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();

    state.client = await signedIn(sponsor.email);
    const attempts: Record<string, () => Promise<unknown>> = {
      pick: () => predictions.submitPredictionAction({ marketId, selectedOutcome: "NO", idempotencyKey: randomUUID() }),
      comment: () => comments.addPostCommentAction(post!.id, "hello from a sponsor"),
      removeComment: () => comments.removePostCommentAction(randomUUID(), post!.id),
      callBs: () => challenges.callBSAction(targetPick, marketId),
      acceptChallenge: () => challenges.acceptChallengeAction(randomUUID(), marketId),
      declineChallenge: () => challenges.declineChallengeAction(randomUUID(), marketId),
      proposeMoney: () => (money.proposeMoneyAction as (...a: unknown[]) => Promise<unknown>)(targetPick, 1000, marketId),
      acceptMoney: () => money.acceptMonetaryProposalAction(randomUUID(), marketId),
      declineMoney: () => money.declineMonetaryProposalAction(randomUUID(), marketId),
      withdrawMoney: () => money.withdrawMonetaryProposalAction(randomUUID(), marketId),
      follow: () => (follows.toggleFollowAction as (...a: unknown[]) => Promise<unknown>)(target, true),
      markRead: () => notifications.markNotificationsReadAction(),
      pollNotifications: () => notifications.getNotificationPollStateAction(),
      walletRequest: () => (walletRequests.submitWalletRequestAction as (...a: unknown[]) => Promise<unknown>)({ amountCents: 1000 }),
      updateProfile: () => (profile.updateProfileAction as (...a: unknown[]) => Promise<unknown>)({ message: null }, new FormData()),
    };
    for (const [name, run] of Object.entries(attempts)) {
      expect(await redirects(run), name).toBe("REDIRECT:/sponsor");
    }

    for (const [table, column] of [["predictions", "user_id"], ["post_comments", "user_id"], ["challenges", "challenger_user_id"], ["monetary_proposals", "proposer_user_id"], ["follows", "follower_id"], ["notifications", "user_id"], ["wallet_requests", "user_id"], ["wallets", "user_id"]] as const) {
      expect((await admin.from(table).select(column).eq(column, sponsor.userId)).data ?? [], table).toEqual([]);
    }
  });

  it("the same actions still work for a Member (the guard is not simply broken)", async () => {
    const memberId = await seedUser("sessiso-member");
    const { data } = await admin.auth.admin.getUserById(memberId);
    const { marketId } = await seedGame({});
    state.client = await signedIn(data.user!.email!);
    expect(await redirects(() => predictions.submitPredictionAction({ marketId, selectedOutcome: "YES", idempotencyKey: randomUUID() }))).toBeNull();
    expect((await admin.from("predictions").select("id").eq("user_id", memberId)).data?.length).toBe(1);
  });

  it("a signed-out caller is sent to the Member login, not the Sponsor area", async () => {
    state.client = getTestAnonClient();
    expect(await redirects(() => comments.addPostCommentAction(randomUUID(), "hi"))).toMatch(/^REDIRECT:\/login/);
  });
});
