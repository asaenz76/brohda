import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let enabled = true;
const advance = vi.fn(async () => ({ wentLive: 1, completed: 2, reservationsReleased: 0 }));
vi.mock("@/lib/jobs/record", () => ({ recordJobRun: async (_name: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/sponsorship/capability", () => ({ isSponsorshipEnabled: async () => enabled }));
vi.mock("@/lib/sponsorship/repository", () => ({ callSponsorshipFunction: advance }));

const call = async (auth?: string) => {
  const { GET } = await import("@/app/api/cron/advance-sponsorships/route");
  return GET(new Request("https://x.test/api/cron/advance-sponsorships", { headers: auth ? { authorization: auth } : {} }));
};

beforeEach(() => {
  enabled = true;
  advance.mockClear();
  process.env.CRON_SECRET = "test-secret";
});

describe("/api/cron/advance-sponsorships", () => {
  it("rejects a missing, wrong or malformed Authorization header — and does nothing", async () => {
    for (const auth of [undefined, "", "Bearer", "Bearer wrong", "test-secret", "bearer test-secret"]) expect((await call(auth)).status, String(auth)).toBe(401);
    expect(advance).not.toHaveBeenCalled();
  });

  it("with no CRON_SECRET configured every request is refused (never open by default)", async () => {
    delete process.env.CRON_SECRET;
    expect((await call("Bearer undefined")).status).toBe(401);
    expect((await call("Bearer ")).status).toBe(401);
    expect(advance).not.toHaveBeenCalled();
  });

  it("authorized + capability ON: advances through the one database function", async () => {
    const res = await call("Bearer test-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ policyEnabled: true, wentLive: 1, completed: 2 });
    expect(advance).toHaveBeenCalledWith("advance_sponsorships", expect.objectContaining({ p_now: expect.any(String) }));
  });

  it("authorized + capability OFF: a healthy no-op — nothing advances, nothing is released, nothing is touched", async () => {
    enabled = false;
    const res = await call("Bearer test-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ policyEnabled: false, wentLive: 0, completed: 0, reservationsReleased: 0 });
    expect(advance).not.toHaveBeenCalled();
  });
});
