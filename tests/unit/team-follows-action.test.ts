import { describe, expect, it, vi, beforeEach } from "vitest";

const FAKE_USER = { id: "user-1" };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => FAKE_USER) }));

const checkTeamFollowRateLimit = vi.fn(async () => true);
vi.mock("@/lib/rate-limit/team-follows", () => ({
  checkTeamFollowRateLimit: () => checkTeamFollowRateLimit(),
  checkLeagueFollowRateLimit: vi.fn(async () => true),
}));

let insertError: { code: string } | null = null;
let deleteError: { code: string } | null = null;
const adminBuilder = {
  insert: vi.fn(async () => ({ error: insertError })),
  delete: vi.fn(() => adminBuilder),
  eq: vi.fn(() => adminBuilder),
};
// .delete().eq().eq() needs to resolve — the last .eq() in the chain is
// awaited directly by the action, so make the builder itself thenable,
// resolving to the configured deleteError.
Object.assign(adminBuilder, {
  then: (resolve: (value: { error: { code: string } | null }) => unknown) =>
    Promise.resolve({ error: deleteError }).then(resolve),
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => adminBuilder }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const TEAM_ID = "22222222-2222-4222-a222-222222222222";

const { toggleTeamFollowAction } = await import("@/lib/actions/team-follows");

beforeEach(() => {
  insertError = null;
  deleteError = null;
  checkTeamFollowRateLimit.mockClear();
  checkTeamFollowRateLimit.mockResolvedValue(true);
});

describe("toggleTeamFollowAction", () => {
  it("treats a 23505 (unique_team_follow) retry as success, not an error", async () => {
    insertError = { code: "23505" };

    const result = await toggleTeamFollowAction(TEAM_ID, false);

    expect(result).toEqual({ error: null, following: true });
  });

  it("returns an error for a real insert failure (non-23505)", async () => {
    insertError = { code: "23000" };

    const result = await toggleTeamFollowAction(TEAM_ID, false);

    expect(result.error).not.toBeNull();
    expect(result.following).toBe(false);
  });

  it("rejects when the rate limit is exceeded, without attempting the write", async () => {
    checkTeamFollowRateLimit.mockResolvedValue(false);

    const result = await toggleTeamFollowAction(TEAM_ID, false);

    expect(result.error).toBe("Too many requests. Try again in a moment.");
    expect(result.following).toBe(false);
  });

  it("rejects a non-uuid teamId before ever checking the rate limit", async () => {
    const result = await toggleTeamFollowAction("not-a-uuid", false);

    expect(result.error).not.toBeNull();
    expect(checkTeamFollowRateLimit).not.toHaveBeenCalled();
  });
});
