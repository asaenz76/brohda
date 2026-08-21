import { beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_ADMIN = { id: "admin-1", role: "super_admin" as const };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireSuperAdmin: vi.fn(async () => FAKE_ADMIN),
  requireAdminOrAbove: vi.fn(async () => FAKE_ADMIN),
}));
vi.mock("@/lib/audit/log", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/pools/follow-recipients", () => ({ getPoolPublishFollowRecipients: vi.fn(async () => []) }));
vi.mock("@/lib/notifications/create", () => ({
  createPoolPublishedFollowNotifications: vi.fn(async () => {}),
}));
vi.mock("@/lib/email/notify-followed-pool-published", () => ({
  notifyFollowedPoolPublished: vi.fn(async () => {}),
}));

let poolRow: Record<string, unknown>;
let siblingRows: Array<Record<string, unknown>>;
let updates: Array<{ scope: "single" | "cascade"; payload: Record<string, unknown> }>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "pools") throw new Error(`Unexpected table in test: ${table}`);
      return {
        select: () => ({
          eq: (col: string) => {
            // The sibling-fetch query: .eq("tier_group_id", ...).neq("id", ...)
            if (col === "tier_group_id") {
              return {
                neq: async () => ({ data: siblingRows, error: null }),
              };
            }
            // The "before" fetch: .select("*").eq("id", poolId).single()
            return { single: async () => ({ data: poolRow }) };
          },
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            updates.push({ scope: "single", payload });
            return { error: null };
          },
          in: async () => {
            updates.push({ scope: "cascade", payload });
            return { error: null };
          },
        }),
      };
    },
  }),
}));

const { updatePoolAction } = await import("@/lib/actions/pools");

function baseFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("poolId", "3fa85f64-5717-4562-b3fc-2c963f66afa6");
  fd.set("entryFee", overrides.entryFee ?? "5.00");
  fd.set("houseFeePercent", overrides.houseFeePercent ?? "5");
  fd.set("visibility", "VISIBLE_TO_ALL_MEMBERS");
  fd.set("participationVisibility", "SHOW_BEFORE_ENTRY");
  fd.set("locksAt", overrides.locksAt ?? new Date(Date.now() + 86_400_000).toISOString());
  return fd;
}

beforeEach(() => {
  poolRow = {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    fixture_id: null,
    tier_group_id: null,
    entry_fee: 500,
    house_fee_bps: 500,
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    participation_visibility: "SHOW_BEFORE_ENTRY",
    locks_at: new Date(Date.now() + 86_400_000).toISOString(),
    first_entry_at: null,
  };
  siblingRows = [];
  updates = [];
});

describe("updatePoolAction — tier-group aware fee editing", () => {
  it("allows changing entry_fee on an ordinary (non-tiered) pool", async () => {
    const result = await updatePoolAction({ error: null }, baseFormData({ entryFee: "7.50" }));

    expect(result.error).toBeNull();
    expect(updates).toEqual([{ scope: "single", payload: expect.objectContaining({ entry_fee: 750 }) }]);
  });

  it("rejects an entry_fee that collides with a sibling tier's current amount", async () => {
    poolRow.tier_group_id = "group-1";
    siblingRows = [{ id: "sibling-1", entry_fee: 1000 }];

    const result = await updatePoolAction({ error: null }, baseFormData({ entryFee: "10.00" }));

    expect(result.error).toMatch(/already uses that entry fee/);
    expect(updates).toEqual([]);
  });

  it("allows an entry_fee change that doesn't collide with any sibling", async () => {
    poolRow.tier_group_id = "group-1";
    siblingRows = [
      { id: "sibling-1", entry_fee: 1000 },
      { id: "sibling-2", entry_fee: 2500 },
    ];

    const result = await updatePoolAction({ error: null }, baseFormData({ entryFee: "7.50" }));

    expect(result.error).toBeNull();
    expect(updates[0]).toEqual({ scope: "single", payload: expect.objectContaining({ entry_fee: 750 }) });
  });

  it("cascades a house_fee_bps change to every sibling tier", async () => {
    poolRow.tier_group_id = "group-1";
    siblingRows = [
      { id: "sibling-1", entry_fee: 1000 },
      { id: "sibling-2", entry_fee: 2500 },
    ];

    const result = await updatePoolAction({ error: null }, baseFormData({ houseFeePercent: "8" }));

    expect(result.error).toBeNull();
    expect(updates).toContainEqual({ scope: "cascade", payload: { house_fee_bps: 800 } });
  });

  it("does not cascade when house_fee_bps is unchanged", async () => {
    poolRow.tier_group_id = "group-1";
    siblingRows = [{ id: "sibling-1", entry_fee: 1000 }];

    const result = await updatePoolAction({ error: null }, baseFormData({ houseFeePercent: "5" }));

    expect(result.error).toBeNull();
    expect(updates.filter((u) => u.scope === "cascade")).toEqual([]);
  });

  it("still allows the same entry_fee value to be resubmitted (no-op, not a collision)", async () => {
    poolRow.tier_group_id = "group-1";
    siblingRows = [{ id: "sibling-1", entry_fee: 1000 }];

    const result = await updatePoolAction({ error: null }, baseFormData({ entryFee: "5.00" }));

    expect(result.error).toBeNull();
  });
});
