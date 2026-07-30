import { describe, expect, it, vi } from "vitest";

// Both no-op guards return before createAdminClient() is ever called, so no
// Supabase mocking is needed here — a call reaching the mock at all would
// itself be a test failure.
const createAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

const { notifyFollowedPoolPublished } = await import("@/lib/email/notify-followed-pool-published");

describe("notifyFollowedPoolPublished", () => {
  it("no-ops when emailUserIds is empty, without touching Supabase", async () => {
    await notifyFollowedPoolPublished({
      pool: { id: "pool-1", question: "Who wins?" },
      emailUserIds: [],
    });

    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("no-ops when RESEND_API_KEY isn't set, without touching Supabase", async () => {
    const original = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;

    await notifyFollowedPoolPublished({
      pool: { id: "pool-1", question: "Who wins?" },
      emailUserIds: ["user-1"],
    });

    expect(createAdminClient).not.toHaveBeenCalled();

    if (original !== undefined) process.env.RESEND_API_KEY = original;
  });
});
