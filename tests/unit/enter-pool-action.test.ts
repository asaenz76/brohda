import { describe, expect, it, vi, beforeEach } from "vitest";

// enterPoolAction is the Server Action wrapper around the well-tested
// create_pool_entry RPC — the admin-block check, the rate-limit check, and
// the validation-error branch live in the action itself, not the RPC, and
// (per the architecture review) had zero direct test coverage. Mocked here
// following the exact pattern already proven in team-follows-action.test.ts,
// since requireUser() depends on Next's cookies() and can't run outside a
// real request context — a real-Postgres integration test can't call this
// action directly either, for the same reason.

let currentUser: { id: string; display_name: string; role: string } = {
  id: "player-1",
  display_name: "Player One",
  role: "player",
};

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => currentUser) }));

const checkEntryRateLimit = vi.fn(async () => true);
vi.mock("@/lib/rate-limit/entries", () => ({
  checkEntryRateLimit: () => checkEntryRateLimit(),
}));

let rpcError: { message: string } | null = null;
let rpcCall: { fn: string; args: Record<string, unknown> } | null = null;
const rpc = vi.fn(async () => ({ data: null, error: rpcError }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCall = { fn, args };
      return rpc();
    },
  }),
}));

const broadcastPoolEntryAdded = vi.fn(async () => {});
vi.mock("@/lib/realtime/pool-updates", () => ({
  broadcastPoolEntryAdded: () => broadcastPoolEntryAdded(),
}));

const createFollowerEntryNotifications = vi.fn(async () => {});
vi.mock("@/lib/notifications/create", () => ({
  createFollowerEntryNotifications: () => createFollowerEntryNotifications(),
}));

const { enterPoolAction } = await import("@/lib/actions/entries");

const POOL_ID = "11111111-1111-4111-a111-111111111111";
const OPTION_ID = "22222222-2222-4222-a222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-a333-333333333333";

function validFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("poolId", overrides.poolId ?? POOL_ID);
  fd.set("optionId", overrides.optionId ?? OPTION_ID);
  fd.set("amountCents", overrides.amountCents ?? "500");
  fd.set("idempotencyKey", overrides.idempotencyKey ?? IDEMPOTENCY_KEY);
  return fd;
}

beforeEach(() => {
  currentUser = { id: "player-1", display_name: "Player One", role: "player" };
  rpcError = null;
  rpcCall = null;
  rpc.mockClear();
  checkEntryRateLimit.mockClear();
  checkEntryRateLimit.mockResolvedValue(true);
  broadcastPoolEntryAdded.mockClear();
  createFollowerEntryNotifications.mockClear();
});

describe("enterPoolAction", () => {
  it("rejects an admin/super_admin without ever calling create_pool_entry", async () => {
    currentUser = { id: "admin-1", display_name: "Admin One", role: "super_admin" };

    const result = await enterPoolAction({ error: null, success: false }, validFormData());

    expect(result).toEqual({ error: "Admins cannot enter pools.", success: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects once the rate limit is exceeded, without calling create_pool_entry", async () => {
    checkEntryRateLimit.mockResolvedValue(false);

    const result = await enterPoolAction({ error: null, success: false }, validFormData());

    expect(result).toEqual({
      error: "Too many attempts — wait a moment and try again.",
      success: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects malformed form data (invalid poolId) before calling create_pool_entry", async () => {
    const result = await enterPoolAction(
      { error: null, success: false },
      validFormData({ poolId: "not-a-uuid" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("succeeds end-to-end for a valid player entry", async () => {
    const result = await enterPoolAction({ error: null, success: false }, validFormData());

    expect(result).toEqual({ error: null, success: true });
    expect(rpcCall).toEqual({
      fn: "create_pool_entry",
      args: {
        p_pool_id: POOL_ID,
        p_user_id: "player-1",
        p_option_id: OPTION_ID,
        p_amount: 500,
        p_idempotency_key: IDEMPOTENCY_KEY,
      },
    });
    expect(broadcastPoolEntryAdded).toHaveBeenCalledTimes(1);
    expect(createFollowerEntryNotifications).toHaveBeenCalledTimes(1);
  });

  it("surfaces the insufficient-balance error from the RPC", async () => {
    rpcError = { message: "insufficient_balance" };

    const result = await enterPoolAction({ error: null, success: false }, validFormData());

    expect(result).toEqual({
      error: "You don't have enough balance for this entry.",
      success: false,
    });
  });
});
