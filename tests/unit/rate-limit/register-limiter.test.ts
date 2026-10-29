import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

const { checkRateLimit, checkRateLimitVerdict } = await import("@/lib/rate-limit/check");
const { checkRegisterRateLimit } = await import("@/lib/rate-limit/register");

afterEach(() => {
  delete process.env.RATE_LIMIT_HMAC_SECRET;
});

beforeEach(() => {
  process.env.RATE_LIMIT_HMAC_SECRET = "unit-test-secret";
  rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("checkRateLimitVerdict / checkRateLimit", () => {
  it("maps the function's answer to allowed / limited", async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null });
    expect(await checkRateLimitVerdict("k", 60, 3)).toBe("allowed");
    expect(await checkRateLimitVerdict("k", 60, 3)).toBe("limited");
    expect(rpc).toHaveBeenCalledWith("check_and_increment_rate_limit", { p_identifier: "k", p_window_seconds: 60, p_max_attempts: 3 });
  });

  it("reports 'unavailable' for a database error and for a thrown failure", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect(await checkRateLimitVerdict("k", 60, 3)).toBe("unavailable");
    rpc.mockRejectedValueOnce(new Error("socket closed"));
    expect(await checkRateLimitVerdict("k", 60, 3)).toBe("unavailable");
  });

  it("the legacy boolean still fails open on an unavailable check and denies only a real 'limited'", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } }).mockResolvedValueOnce({ data: false, error: null });
    expect(await checkRateLimit("k", 60, 3)).toBe(true);
    expect(await checkRateLimit("k", 60, 3)).toBe(false);
  });
});

describe("checkRegisterRateLimit", () => {
  it("spends the email budget then the network budget, each under a hashed key (no email or address in the bucket)", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await checkRegisterRateLimit("someone@example.com", "203.0.113.9")).toBe("allowed");
    expect(rpc).toHaveBeenCalledTimes(2);
    const ids = rpc.mock.calls.map((call) => call[1].p_identifier as string);
    expect(ids[0]).toMatch(/^register:[0-9a-f]{32}$/);
    expect(ids[1]).toMatch(/^register-net:[0-9a-f]{32}$/);
    expect(ids.join(" ")).not.toContain("someone");
    expect(ids.join(" ")).not.toContain("203.0.113.9");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_window_seconds: 900, p_max_attempts: 5 });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_window_seconds: 3600, p_max_attempts: 20 });
  });

  it("applies no network budget until the rollout switch (RATE_LIMIT_HMAC_SECRET) is set", async () => {
    delete process.env.RATE_LIMIT_HMAC_SECRET;
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await checkRegisterRateLimit("someone@example.com", "203.0.113.9")).toBe("allowed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("skips the network budget when there is no trusted address", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    expect(await checkRegisterRateLimit("someone@example.com", null)).toBe("allowed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("an exhausted email budget stops there; an exhausted network budget refuses even a fresh email", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await checkRegisterRateLimit("a@example.com", "203.0.113.9")).toBe("limited");
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: false, error: null });
    expect(await checkRegisterRateLimit("fresh@example.com", "203.0.113.9")).toBe("limited");
  });

  it("does NOT fail open: a limiter that cannot answer is 'unavailable', never 'allowed'", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    expect(await checkRegisterRateLimit("a@example.com", "203.0.113.9")).toBe("unavailable");
    expect(await checkRegisterRateLimit("a@example.com", null)).toBe("unavailable");
  });

  it("logs the scope of a refusal, never the email or the address", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await checkRegisterRateLimit("someone@example.com", "203.0.113.9");
    const logged = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(" ");
    expect(logged).toContain("[register]");
    expect(logged).not.toContain("someone");
    expect(logged).not.toContain("203.0.113.9");
  });
});
