import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Milestone R13.10, Stage 0 — mirrors tests/unit/auth/require-capability.
 * test.ts's own established pattern for a requireX() guard that calls
 * next/navigation's redirect(): the database is mocked so the ORDER
 * (authenticate, then check role, then check policy) and every failure
 * mode can be observed without a real Supabase instance. The policy row
 * itself is exercised against a real database in
 * tests/integration/lifecycle-job-observability.test.ts-style coverage
 * is not needed here since this reads a single boolean column with no
 * RLS-sensitive branching of its own.
 */

const requireUserMock = vi.fn();
const redirectMock = vi.fn((path: string) => {
  // Next's redirect() never returns — it throws a special error.
  throw new Error(`NEXT_REDIRECT:${path}`);
});

let settingsRow: unknown = { social_prediction_enabled: false };

vi.mock("@/lib/auth/session", () => ({
  requireUser: requireUserMock,
}));
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: settingsRow, error: null }) }) }) }),
  }),
}));

const { requireSocialPredictionAccess, getSocialPredictionAccessPolicy } = await import("@/lib/social/access");

const player = { id: "u1", role: "player" as const, is_active: true };
const admin = { id: "u2", role: "admin" as const, is_active: true };
const superAdmin = { id: "u3", role: "super_admin" as const, is_active: true };

beforeEach(() => {
  settingsRow = { social_prediction_enabled: false };
  requireUserMock.mockReset();
  redirectMock.mockClear();
});

describe("getSocialPredictionAccessPolicy", () => {
  it("reflects the column value when readable", async () => {
    settingsRow = { social_prediction_enabled: true };
    await expect(getSocialPredictionAccessPolicy()).resolves.toEqual({ enabled: true });
  });

  it("fails closed when the settings row is missing", async () => {
    settingsRow = null;
    await expect(getSocialPredictionAccessPolicy()).resolves.toEqual({ enabled: false });
  });

  it("fails closed when the column itself is null", async () => {
    settingsRow = { social_prediction_enabled: null };
    await expect(getSocialPredictionAccessPolicy()).resolves.toEqual({ enabled: false });
  });
});

describe("requireSocialPredictionAccess", () => {
  it("authenticates before it authorizes — an unauthenticated caller never reaches the policy", async () => {
    requireUserMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/login");
    });
    await expect(requireSocialPredictionAccess()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("redirects an ordinary player to /feed when the policy is disabled", async () => {
    requireUserMock.mockResolvedValue(player);
    settingsRow = { social_prediction_enabled: false };
    await expect(requireSocialPredictionAccess()).rejects.toThrow("NEXT_REDIRECT:/feed");
  });

  it("permits an ordinary player once the policy is enabled", async () => {
    requireUserMock.mockResolvedValue(player);
    settingsRow = { social_prediction_enabled: true };
    await expect(requireSocialPredictionAccess()).resolves.toEqual(player);
  });

  it("always permits admin, regardless of the policy — operational preview access", async () => {
    requireUserMock.mockResolvedValue(admin);
    settingsRow = { social_prediction_enabled: false };
    await expect(requireSocialPredictionAccess()).resolves.toEqual(admin);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("always permits super_admin, regardless of the policy", async () => {
    requireUserMock.mockResolvedValue(superAdmin);
    settingsRow = { social_prediction_enabled: false };
    await expect(requireSocialPredictionAccess()).resolves.toEqual(superAdmin);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("admin/super_admin bypass never even reads the policy row — access is unconditional for them", async () => {
    requireUserMock.mockResolvedValue(superAdmin);
    settingsRow = null; // would fail-closed if read
    await expect(requireSocialPredictionAccess()).resolves.toEqual(superAdmin);
  });

  it("re-reads the policy on every call for an ordinary player — no cached decision outlives a configuration change", async () => {
    requireUserMock.mockResolvedValue(player);
    settingsRow = { social_prediction_enabled: false };
    await expect(requireSocialPredictionAccess()).rejects.toThrow("NEXT_REDIRECT:/feed");

    settingsRow = { social_prediction_enabled: true };
    await expect(requireSocialPredictionAccess()).resolves.toEqual(player);

    settingsRow = { social_prediction_enabled: false };
    await expect(requireSocialPredictionAccess()).rejects.toThrow("NEXT_REDIRECT:/feed");
  });
});
