import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { deriveConsumerMonetaryAccess } from "@/lib/monetary/capability";

const base = { flagEnabled: false, isOperator: false, totalCents: 0, heldCents: 0 };

describe("deriveConsumerMonetaryAccess — the one consumer money capability", () => {
  it("money on: the wallet and everything money-related is available", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, flagEnabled: true })).toEqual({ enabled: true, canSeeWallet: true, windDownOnly: false, isOperator: false });
  });

  it("money off + a player with nothing in the system: no wallet at all (a complete free product)", () => {
    expect(deriveConsumerMonetaryAccess(base)).toEqual({ enabled: false, canSeeWallet: false, windDownOnly: false, isOperator: false });
  });

  it("money off + a player who still has funds: the wallet stays reachable, wind-down only (no funding)", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, totalCents: 2_500 })).toEqual({ enabled: false, canSeeWallet: true, windDownOnly: true, isOperator: false });
  });

  it("money off + only a hold (an open offer or a committed Position): the wallet is reachable so nothing is stranded", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, totalCents: 0, heldCents: 1_000 })).toMatchObject({ canSeeWallet: true, windDownOnly: true });
  });

  it("money off + an operator with nothing in the system: NO wallet — being an admin is not a reason to see one (admin tools live under Admin)", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, isOperator: true })).toEqual({ enabled: false, canSeeWallet: false, windDownOnly: false, isOperator: true });
  });

  it("money off + an operator who still has funds or a hold: the same wind-down wallet as anyone, no funding", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, isOperator: true, totalCents: 225 })).toEqual({ enabled: false, canSeeWallet: true, windDownOnly: true, isOperator: true });
    expect(deriveConsumerMonetaryAccess({ ...base, isOperator: true, heldCents: 500 })).toMatchObject({ canSeeWallet: true, windDownOnly: true });
  });

  it("money on: operators see it like everyone, and it is not wind-down", () => {
    expect(deriveConsumerMonetaryAccess({ ...base, flagEnabled: true, isOperator: true })).toEqual({ enabled: true, canSeeWallet: true, windDownOnly: false, isOperator: true });
  });
});
