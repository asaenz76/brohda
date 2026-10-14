import { beforeEach, describe, expect, it, vi } from "vitest";

let result: { data: Record<string, unknown> | null; error: unknown };
let throws = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (throws) throw new Error("unavailable");
    return { from: () => ({ select: () => ({ eq: () => ({ single: async () => result }) }) }) };
  },
}));
const { getMessagingConfig, isMessagingEnabled } = await import("@/lib/messaging/config");

const good = (over: Record<string, unknown> = {}) => ({
  data: {
    messaging_enabled: true, messaging_max_message_length: 1000, messaging_max_unanswered_requests: 2, messaging_unsend_window_seconds: 900, messaging_poll_interval_seconds: 10,
    messaging_send_rate_window_seconds: 60, messaging_send_rate_max: 20, messaging_request_rate_window_seconds: 3600, messaging_request_rate_max: 5, messaging_report_rate_window_seconds: 3600, messaging_report_rate_max: 10,
    ...over,
  },
  error: null,
});
beforeEach(() => {
  throws = false;
  result = good();
});

describe("Messaging fails closed", () => {
  it("is ON only for a successfully read literal true with every number valid, and returns the policy it read", async () => {
    const c = await getMessagingConfig();
    expect(c).toMatchObject({ enabled: true, maxMessageLength: 1000, maxUnansweredRequests: 2, unsendWindowSeconds: 900, pollIntervalSeconds: 10, sendRate: { windowSeconds: 60, max: 20 } });
    expect(await isMessagingEnabled()).toBe(true);
  });

  it("is OFF for false, a missing row, a read error, a thrown client or a non-literal true", async () => {
    for (const r of [good({ messaging_enabled: false }), { data: null, error: null }, { data: null, error: { message: "boom" } }, good({ messaging_enabled: "true" }), good({ messaging_enabled: 1 })]) {
      result = r as typeof result;
      expect(await isMessagingEnabled(), JSON.stringify(r.data)).toBe(false);
    }
    throws = true;
    expect(await isMessagingEnabled()).toBe(false);
  });

  it("the full policy is refused (null = OFF) when any number is malformed — the pages never run with a missing limit", async () => {
    for (const bad of [{ messaging_max_message_length: 0 }, { messaging_max_unanswered_requests: null }, { messaging_send_rate_max: -1 }, { messaging_poll_interval_seconds: 1.5 }, { messaging_unsend_window_seconds: -5 }, { messaging_report_rate_max: "10" }]) {
      result = good(bad) as typeof result;
      expect(await getMessagingConfig(), JSON.stringify(bad)).toBeNull();
    }
  });

  it("the shell's cheap check reads ONLY the flag (one boolean), so it can show the entry without loading the policy", async () => {
    result = { data: { messaging_enabled: true }, error: null };
    expect(await isMessagingEnabled()).toBe(true);
    result = { data: { messaging_enabled: false }, error: null };
    expect(await isMessagingEnabled()).toBe(false);
  });

  it("an unsend window of 0 is valid (it turns unsending off) and is not a malformed value", async () => {
    result = good({ messaging_unsend_window_seconds: 0 }) as typeof result;
    expect((await getMessagingConfig())?.unsendWindowSeconds).toBe(0);
  });
});
