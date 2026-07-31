import { describe, expect, it, vi, beforeEach } from "vitest";

const FAKE_ADMIN = { id: "admin-1" };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSuperAdmin: vi.fn(async () => FAKE_ADMIN) }));
vi.mock("@/lib/audit/log", () => ({ writeAuditLog: vi.fn(async () => {}) }));

let updatePayload: unknown = null;
let updateError: { message: string } | null = null;
const adminBuilder = {
  update: vi.fn((payload: unknown) => {
    updatePayload = payload;
    return adminBuilder;
  }),
  eq: vi.fn(() => Promise.resolve({ error: updateError })),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => adminBuilder }),
}));

const { setPoolFeeDefaultsAction } = await import("@/lib/actions/settings");

beforeEach(() => {
  updatePayload = null;
  updateError = null;
  adminBuilder.update.mockClear();
});

describe("setPoolFeeDefaultsAction", () => {
  it("rejects an invalid entry fee without writing anything", async () => {
    const result = await setPoolFeeDefaultsAction("not-a-number", "5");

    expect(result).toEqual({ success: false, error: "Enter a valid entry fee and platform fee." });
    expect(adminBuilder.update).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range platform fee (over 100%) without writing anything", async () => {
    const result = await setPoolFeeDefaultsAction("5.00", "150");

    expect(result.success).toBe(false);
    expect(adminBuilder.update).not.toHaveBeenCalled();
  });

  it("parses valid input into cents/bps and writes them", async () => {
    const result = await setPoolFeeDefaultsAction("7.50", "6.5");

    expect(result).toEqual({ success: true, error: null });
    expect(updatePayload).toMatchObject({ default_entry_fee_cents: 750, default_house_fee_bps: 650 });
  });

  it("surfaces a generic error when the update itself fails", async () => {
    updateError = { message: "db exploded" };
    const result = await setPoolFeeDefaultsAction("5.00", "5");

    expect(result).toEqual({ success: false, error: "Could not update these defaults." });
  });
});
