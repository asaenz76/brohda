import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session half of the capability gate (Milestone 2 final standing-rule
 * remediation): authentication happens first and is unchanged, the policy
 * decides second, and a denied user is redirected exactly like
 * `requireSuperAdmin()` denies. The policy's own contents are tested against
 * a real database in tests/integration/capability-policy.test.ts; here the
 * database is mocked so the ORDER and the failure modes can be observed.
 */

const requireUserMock = vi.fn();
const redirectMock = vi.fn((path: string) => {
  // Next's redirect() never returns — it throws a special error.
  throw new Error(`NEXT_REDIRECT:${path}`);
});

let policyRow: unknown = { capability: "discovery_taxonomy_management", allowed_roles: ["super_admin"] };
let policyError: unknown = null;
let policyThrows = false;
const maybeSingle = vi.fn(async () => {
  if (policyThrows) throw new Error("connection refused");
  return { data: policyRow, error: policyError };
});

vi.mock("@/lib/auth/session", () => ({
  requireUser: requireUserMock,
}));
vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));

const { requireCapability } = await import("@/lib/auth/capabilities");

const CAPABILITY = "discovery_taxonomy_management";
const superAdmin = { id: "u1", role: "super_admin", is_active: true };

beforeEach(() => {
  policyRow = { capability: CAPABILITY, allowed_roles: ["super_admin"] };
  policyError = null;
  policyThrows = false;
  requireUserMock.mockResolvedValue(superAdmin);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("requireCapability", () => {
  it("returns the authenticated profile when the configured policy permits their role", async () => {
    await expect(requireCapability(CAPABILITY)).resolves.toEqual(superAdmin);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("authenticates before it authorizes — an unauthenticated caller never reaches the policy", async () => {
    requireUserMock.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT:/login");
    });

    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("redirects a role the policy does not list", async () => {
    requireUserMock.mockResolvedValue({ ...superAdmin, role: "admin" });

    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");
  });

  it("permits that same role once the configuration lists it — the only thing that changed is a row", async () => {
    requireUserMock.mockResolvedValue({ ...superAdmin, role: "admin" });
    policyRow = { capability: CAPABILITY, allowed_roles: ["super_admin", "admin"] };

    await expect(requireCapability(CAPABILITY)).resolves.toMatchObject({ role: "admin" });
  });

  it("denies when the policy row is missing", async () => {
    policyRow = null;

    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");
  });

  it("denies when the policy cannot be read at all", async () => {
    policyError = { message: "permission denied" };
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");

    policyError = null;
    policyThrows = true;
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");
  });

  it("denies when the policy is malformed, rather than falling back to a broader role", async () => {
    policyRow = { capability: CAPABILITY, allowed_roles: "super_admin" };
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");

    policyRow = { capability: CAPABILITY, allowed_roles: ["super_admin", "supper_admin"] };
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");
  });

  it("re-reads the policy on every call — no cached decision outlives a configuration change", async () => {
    requireUserMock.mockResolvedValue({ ...superAdmin, role: "admin" });
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");

    policyRow = { capability: CAPABILITY, allowed_roles: ["admin"] };
    await expect(requireCapability(CAPABILITY)).resolves.toMatchObject({ role: "admin" });

    policyRow = { capability: CAPABILITY, allowed_roles: ["super_admin"] };
    await expect(requireCapability(CAPABILITY)).rejects.toThrow("NEXT_REDIRECT:/feed");
  });
});
