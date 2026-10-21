// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSuperAdmin = vi.fn();
const runGeneration = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSuperAdmin: (...a: unknown[]) => requireSuperAdmin(...a) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/game-previews/repository", () => ({ getGamePreviewForFixture: vi.fn(async () => null) }));
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
