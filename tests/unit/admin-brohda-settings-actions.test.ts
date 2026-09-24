import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrohdaSettings } from "@/lib/admin-settings/types";

/**
 * Milestone R12 (Admin + Configuration) — unit tests for the 9 Server
 * Actions in lib/actions/brohda-settings.ts.
 *
 * Scope boundary: `requireSuperAdmin()`'s own role-comparison logic
 * (super_admin vs admin vs player vs unauthenticated) is already
 * exhaustively unit-tested in tests/unit/guards.test.ts via isSuperAdmin();
 * re-deriving that here per-action would be redundant. What THIS file
 * verifies is specific to these 9 new actions: (1) every one of them calls
 * requireSuperAdmin() as its first step and never reaches the repository/
 * RPC layer when that gate rejects — proving the whole Brohda 2.0 settings
 * surface, financial settings included, is gated identically and as
 * strictly as the pre-existing monolithic /admin/settings page (§7); (2)
 * every TS-side validation branch (mirroring each RPC's own DB CHECK
 * constraint) rejects bad input without ever calling the repository; (3) a
 * `conflict` outcome from the repository is surfaced as a distinct,
 * actionable result rather than silently succeeding; (4) a repository
 * throw is caught and surfaced as a clean, generic error, never leaking
 * internals or crashing the action.
 */

const REJECT = new Error("NEXT_REDIRECT:/feed");

let requireSuperAdminImpl: () => Promise<{ id: string }> = async () => ({ id: "super-admin-1" });
const requireSuperAdminMock = vi.fn(() => requireSuperAdminImpl());

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSuperAdmin: requireSuperAdminMock }));

type RepoFn = (...args: unknown[]) => Promise<{ settings: BrohdaSettings; outcome: "updated" | "conflict" }>;

let repoOutcome: "updated" | "conflict" = "updated";
let repoThrows: Error | null = null;
let repoCalls: Array<{ fn: string; args: unknown[] }> = [];

function fakeSettings(overrides: Partial<BrohdaSettings> = {}): BrohdaSettings {
  return {
    predictions: { pickLockMinutesBeforeKickoff: 10, predictionCutoffMinutesBeforeClose: 0, predictionAllowRepeat: false, predictionAllowStalePrice: true, predictionAllowUnavailablePrice: false, predictionAllowClosedMarket: false },
    notifications: {
      predictionNotificationsEnabled: true,
      predictionNotifyOnCorrect: true,
      predictionNotifyOnIncorrect: true,
      predictionNotifyOnVoid: true,
      predictionNotifyTitleCorrect: "You were right",
      predictionNotifyBodyCorrect: "Correct.",
      predictionNotifyTitleIncorrect: "Result is in",
      predictionNotifyBodyIncorrect: "Incorrect.",
      predictionNotifyTitleVoid: "No result",
      predictionNotifyBodyVoid: "Void.",
    },
    markets: { marketIngestionEnabled: true, marketIngestionMinBookmakerCount: 2, postPublicationEnabled: true, postPublicationRequiresActiveMarket: true, socialPredictionEnabled: false },
    communities: { communityDistributionEnabled: true, communityTeamDistributionEnabled: true, communityLeagueDistributionEnabled: true, communitySportDistributionEnabled: true },
    conversation: { postCommentMaxLength: 500, postCommentRateLimitWindowSeconds: 60, postCommentRateLimitMaxAttempts: 10 },
    callBs: { callBsEnabled: true, callBsRateLimitWindowSeconds: 60, callBsRateLimitMaxAttempts: 10 },
    monetary: { monetaryP2pEnabled: true, monetaryProposalRateLimitWindowSeconds: 60, monetaryProposalRateLimitMaxAttempts: 10, p2pFeeBps: 0 },
    reputation: { leaderboardMinDecidedPicks: 5 },
    operations: { settlementBatchSize: 500, gradingBatchSize: 200, challengeResolutionBatchSize: 200, jobStalenessMultiplier: 3 },
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedByDisplayName: "Test Admin",
    ...overrides,
  };
}

function makeRepoFn(name: string): RepoFn {
  return async (...args: unknown[]) => {
    repoCalls.push({ fn: name, args });
    if (repoThrows) throw repoThrows;
    return { settings: fakeSettings(), outcome: repoOutcome };
  };
}

vi.mock("@/lib/admin-settings/repository", () => ({
  updatePredictionSettings: makeRepoFn("updatePredictionSettings"),
  updateNotificationSettings: makeRepoFn("updateNotificationSettings"),
  updateMarketSettings: makeRepoFn("updateMarketSettings"),
  updateCommunitySettings: makeRepoFn("updateCommunitySettings"),
  updateConversationSettings: makeRepoFn("updateConversationSettings"),
  updateCallBsSettings: makeRepoFn("updateCallBsSettings"),
  updateMonetarySettings: makeRepoFn("updateMonetarySettings"),
  updateReputationSettings: makeRepoFn("updateReputationSettings"),
  updateOperationsSettings: makeRepoFn("updateOperationsSettings"),
}));

const {
  updatePredictionSettingsAction,
  updateNotificationSettingsAction,
  updateMarketSettingsAction,
  updateCommunitySettingsAction,
  updateConversationSettingsAction,
  updateCallBsSettingsAction,
  updateMonetarySettingsAction,
  updateReputationSettingsAction,
  updateOperationsSettingsAction,
} = await import("@/lib/actions/brohda-settings");

const VALID_PREDICTIONS = { pickLockMinutesBeforeKickoff: 10, predictionCutoffMinutesBeforeClose: 0, predictionAllowRepeat: false, predictionAllowStalePrice: true, predictionAllowUnavailablePrice: false, predictionAllowClosedMarket: false };
const VALID_NOTIFICATIONS = fakeSettings().notifications;
const VALID_MARKETS = { marketIngestionEnabled: true, marketIngestionMinBookmakerCount: 2, postPublicationEnabled: true, postPublicationRequiresActiveMarket: true, socialPredictionEnabled: false };
const VALID_COMMUNITIES = { communityDistributionEnabled: true, communityTeamDistributionEnabled: true, communityLeagueDistributionEnabled: true, communitySportDistributionEnabled: true };
const VALID_CONVERSATION = { postCommentMaxLength: 500, postCommentRateLimitWindowSeconds: 60, postCommentRateLimitMaxAttempts: 10 };
const VALID_CALL_BS = { callBsEnabled: true, callBsRateLimitWindowSeconds: 60, callBsRateLimitMaxAttempts: 10 };
const VALID_MONETARY = { monetaryP2pEnabled: true, monetaryProposalRateLimitWindowSeconds: 60, monetaryProposalRateLimitMaxAttempts: 10, feePercent: "2.5" };
const VALID_REPUTATION = { leaderboardMinDecidedPicks: 5 };
const VALID_OPERATIONS = { settlementBatchSize: 500, gradingBatchSize: 200, challengeResolutionBatchSize: 200, jobStalenessMultiplier: 3 };
const T0 = "2026-01-01T00:00:00.000Z";

const ACTIONS: Array<{ name: string; call: () => Promise<{ success: boolean; error: string | null; conflict: boolean }>; repoFn: string }> = [
  { name: "Predictions", call: () => updatePredictionSettingsAction(T0, VALID_PREDICTIONS), repoFn: "updatePredictionSettings" },
  { name: "Notifications", call: () => updateNotificationSettingsAction(T0, VALID_NOTIFICATIONS), repoFn: "updateNotificationSettings" },
  { name: "Markets", call: () => updateMarketSettingsAction(T0, VALID_MARKETS), repoFn: "updateMarketSettings" },
  { name: "Communities", call: () => updateCommunitySettingsAction(T0, VALID_COMMUNITIES), repoFn: "updateCommunitySettings" },
  { name: "Conversation", call: () => updateConversationSettingsAction(T0, VALID_CONVERSATION), repoFn: "updateConversationSettings" },
  { name: "Call BS", call: () => updateCallBsSettingsAction(T0, VALID_CALL_BS), repoFn: "updateCallBsSettings" },
  { name: "Monetary P2P", call: () => updateMonetarySettingsAction(T0, VALID_MONETARY), repoFn: "updateMonetarySettings" },
  { name: "Reputation", call: () => updateReputationSettingsAction(T0, VALID_REPUTATION), repoFn: "updateReputationSettings" },
  { name: "Operations", call: () => updateOperationsSettingsAction(T0, VALID_OPERATIONS), repoFn: "updateOperationsSettings" },
];

beforeEach(() => {
  requireSuperAdminImpl = async () => ({ id: "super-admin-1" });
  requireSuperAdminMock.mockClear();
  repoOutcome = "updated";
  repoThrows = null;
  repoCalls = [];
});

describe("Authorization — every Brohda settings action, including the financial one", () => {
  for (const action of ACTIONS) {
    it(`${action.name}: calls requireSuperAdmin() and never reaches the repository when it rejects (unauthenticated/player/admin)`, async () => {
      requireSuperAdminImpl = async () => {
        throw REJECT;
      };
      await expect(action.call()).rejects.toThrow("NEXT_REDIRECT:/feed");
      expect(requireSuperAdminMock).toHaveBeenCalledTimes(1);
      expect(repoCalls).toHaveLength(0);
    });

    it(`${action.name}: proceeds to the repository once requireSuperAdmin() resolves (super_admin)`, async () => {
      const result = await action.call();
      expect(result.success).toBe(true);
      expect(repoCalls.map((c) => c.fn)).toEqual([action.repoFn]);
    });
  }
});

describe("Conflict handling", () => {
  it("surfaces a distinct, actionable conflict result instead of silently overwriting", async () => {
    repoOutcome = "conflict";
    const result = await updatePredictionSettingsAction(T0, VALID_PREDICTIONS);
    expect(result).toMatchObject({ success: false, conflict: true });
    expect(result.error).toMatch(/someone else changed/i);
    expect(result.settings).not.toBeNull();
  });
});

describe("Repository failure handling", () => {
  it("catches an unexpected repository throw and returns a clean, generic error", async () => {
    repoThrows = new Error("connection reset");
    const result = await updatePredictionSettingsAction(T0, VALID_PREDICTIONS);
    expect(result).toEqual({ success: false, error: "Could not update Predictions settings.", conflict: false, settings: null });
  });
});

describe("Predictions validation", () => {
  it("rejects a negative pick lock without calling the repository", async () => {
    const result = await updatePredictionSettingsAction(T0, { ...VALID_PREDICTIONS, pickLockMinutesBeforeKickoff: -1 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });

  it("rejects a negative prediction cutoff without calling the repository", async () => {
    const result = await updatePredictionSettingsAction(T0, { ...VALID_PREDICTIONS, predictionCutoffMinutesBeforeClose: -1 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });
});

describe("Notifications validation", () => {
  it("rejects an empty title/body across every one of the 6 copy fields", async () => {
    const fields = ["predictionNotifyTitleCorrect", "predictionNotifyBodyCorrect", "predictionNotifyTitleIncorrect", "predictionNotifyBodyIncorrect", "predictionNotifyTitleVoid", "predictionNotifyBodyVoid"] as const;
    for (const field of fields) {
      repoCalls = [];
      const result = await updateNotificationSettingsAction(T0, { ...VALID_NOTIFICATIONS, [field]: "   " });
      expect(result.success).toBe(false);
      expect(repoCalls).toHaveLength(0);
    }
  });
});

describe("Markets validation", () => {
  it("rejects a minimum bookmaker count below 1", async () => {
    const result = await updateMarketSettingsAction(T0, { ...VALID_MARKETS, marketIngestionMinBookmakerCount: 0 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });
});

describe("Conversation validation", () => {
  it("rejects a max comment length outside 1-2000", async () => {
    for (const bad of [0, 2001]) {
      repoCalls = [];
      const result = await updateConversationSettingsAction(T0, { ...VALID_CONVERSATION, postCommentMaxLength: bad });
      expect(result.success).toBe(false);
      expect(repoCalls).toHaveLength(0);
    }
  });

  it("rejects a rate-limit window or attempt count below 1", async () => {
    let result = await updateConversationSettingsAction(T0, { ...VALID_CONVERSATION, postCommentRateLimitWindowSeconds: 0 });
    expect(result.success).toBe(false);
    result = await updateConversationSettingsAction(T0, { ...VALID_CONVERSATION, postCommentRateLimitMaxAttempts: 0 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });
});

describe("Call BS validation", () => {
  it("rejects a rate-limit window or attempt count below 1", async () => {
    let result = await updateCallBsSettingsAction(T0, { ...VALID_CALL_BS, callBsRateLimitWindowSeconds: 0 });
    expect(result.success).toBe(false);
    result = await updateCallBsSettingsAction(T0, { ...VALID_CALL_BS, callBsRateLimitMaxAttempts: 0 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });
});

describe("Monetary P2P validation — the financial domain", () => {
  it("rejects a rate-limit window or attempt count below 1", async () => {
    let result = await updateMonetarySettingsAction(T0, { ...VALID_MONETARY, monetaryProposalRateLimitWindowSeconds: 0 });
    expect(result.success).toBe(false);
    result = await updateMonetarySettingsAction(T0, { ...VALID_MONETARY, monetaryProposalRateLimitMaxAttempts: 0 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });

  it("rejects a malformed or out-of-range fee percentage without calling the repository", async () => {
    for (const bad of ["not-a-number", "-1", "150"]) {
      repoCalls = [];
      const result = await updateMonetarySettingsAction(T0, { ...VALID_MONETARY, feePercent: bad });
      expect(result.success).toBe(false);
      expect(repoCalls).toHaveLength(0);
    }
  });

  it("converts a valid percentage string into basis points via the shared money utility before calling the repository", async () => {
    await updateMonetarySettingsAction(T0, { ...VALID_MONETARY, feePercent: "2.5" });
    expect(repoCalls[0].args[2]).toMatchObject({ p2pFeeBps: 250 });
  });
});

describe("Reputation validation", () => {
  it("rejects a negative leaderboard minimum", async () => {
    const result = await updateReputationSettingsAction(T0, { ...VALID_REPUTATION, leaderboardMinDecidedPicks: -1 });
    expect(result.success).toBe(false);
    expect(repoCalls).toHaveLength(0);
  });
});

describe("Operations validation", () => {
  it("rejects a settlement batch size outside 1-5000", async () => {
    for (const bad of [0, 5001]) {
      repoCalls = [];
      const result = await updateOperationsSettingsAction(T0, { ...VALID_OPERATIONS, settlementBatchSize: bad });
      expect(result.success).toBe(false);
      expect(repoCalls).toHaveLength(0);
    }
  });

  it("rejects a job staleness multiplier outside 1-20", async () => {
    for (const bad of [0, 21]) {
      repoCalls = [];
      const result = await updateOperationsSettingsAction(T0, { ...VALID_OPERATIONS, jobStalenessMultiplier: bad });
      expect(result.success).toBe(false);
      expect(repoCalls).toHaveLength(0);
    }
  });
});
