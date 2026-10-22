// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSuperAdmin = vi.fn();
const runGeneration = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSuperAdmin: (...a: unknown[]) => requireSuperAdmin(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
const adminState = vi.fn();
vi.mock("@/lib/game-previews/repository", () => ({
  getGamePreviewAdminState: (...a: unknown[]) => adminState(...a),
  adminGenerationReason: (state: { status: string | null }) => (state.status === "PUBLISHED" ? "MANUAL_ADMIN_REQUEST" : "MISSING"),
}));
vi.mock("@/lib/game-previews/automation", () => ({ runGamePreviewGenerationFor: (...a: unknown[]) => runGeneration(...a) }));

import { generateGamePreviewAction } from "@/lib/actions/game-previews-admin";

const FIXTURE = "11111111-1111-4111-8111-111111111111";
const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("fixture_id", FIXTURE);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};

describe("Admin Generate: the actor is the authenticated server session, never the request", () => {
  beforeEach(() => {
    requireSuperAdmin.mockReset();
    runGeneration.mockReset();
    adminState.mockReset();
    adminState.mockResolvedValue({ exists: false, status: null, visible: false });
    runGeneration.mockResolvedValue({ configured: false, error: "No credentials are configured for the selected provider." });
  });

  it("passes the authenticated Admin's id and the ADMIN trigger to the run", async () => {
    requireSuperAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await generateGamePreviewAction(null, form());
    expect(runGeneration).toHaveBeenCalledWith(FIXTURE, "MISSING", "ADMIN", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("ignores any actor a client puts in the form: a forged actor_id / admin_id / actor field changes nothing", async () => {
    requireSuperAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    await generateGamePreviewAction(null, form({ actor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", admin_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", actor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    expect(runGeneration.mock.calls[0][3]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("a caller who is not a Super Admin never reaches generation (the guard throws before any run)", async () => {
    requireSuperAdmin.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(generateGamePreviewAction(null, form({ actor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))).rejects.toThrow();
    expect(runGeneration).not.toHaveBeenCalled();
  });
});

describe("Admin Generate / Regenerate decide from the canonical stored Preview, not the public getter", () => {
  beforeEach(() => {
    requireSuperAdmin.mockReset();
    runGeneration.mockReset();
    adminState.mockReset();
    requireSuperAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    runGeneration.mockResolvedValue({ configured: false, error: "No credentials are configured for the selected provider." });
  });
  const reasonFor = async (state: { exists: boolean; status: string | null; visible: boolean }) => {
    adminState.mockResolvedValue(state);
    await generateGamePreviewAction(null, form());
    return runGeneration.mock.calls.at(-1)![1];
  };
  it("(A) no stored Preview -> MISSING (create)", async () => {
    expect(await reasonFor({ exists: false, status: null, visible: false })).toBe("MISSING");
  });
  it("(B) a visible published Preview -> MANUAL_ADMIN_REQUEST (regenerate, never a second insert)", async () => {
    expect(await reasonFor({ exists: true, status: "PUBLISHED", visible: true })).toBe("MANUAL_ADMIN_REQUEST");
  });
  it("(C) a published Preview hidden from Members (its credit became ineligible) -> MANUAL_ADMIN_REQUEST: the Bengals @ Ravens failure", async () => {
    expect(await reasonFor({ exists: true, status: "PUBLISHED", visible: false })).toBe("MANUAL_ADMIN_REQUEST");
  });
  it("(E) a withdrawn Preview -> MISSING (the database replaces a withdrawn row only through MISSING)", async () => {
    expect(await reasonFor({ exists: true, status: "WITHDRAWN", visible: false })).toBe("MISSING");
  });
});

describe("Admin Generate and a scheduled run never race on the same Game", () => {
  beforeEach(() => {
    requireSuperAdmin.mockReset();
    runGeneration.mockReset();
    adminState.mockReset();
    adminState.mockResolvedValue({ exists: false, status: null, visible: false });
    requireSuperAdmin.mockResolvedValue({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("(P) when the Game's generation lease is held, Generate says so plainly, saves nothing and invents no result", async () => {
    runGeneration.mockResolvedValue({ configured: true, busy: true });
    const result = await generateGamePreviewAction(null, form());
    expect(result).toEqual({ success: false, error: "A Preview is already being generated for this Game. Try again in a few minutes." });
  });
});
