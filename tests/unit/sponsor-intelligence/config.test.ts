import { beforeEach, describe, expect, it, vi } from "vitest";

let settingsResult: { data: Record<string, unknown> | null; error: unknown };
let throwOnRead = false;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (throwOnRead) throw new Error("client unavailable");
    return { from: () => ({ select: () => ({ eq: () => ({ single: async () => settingsResult }) }) }) };
  },
}));
// The service imports repository code that is irrelevant here.
vi.mock("@/lib/sponsorship/repository", () => ({ getSponsorshipForUser: vi.fn(), getSponsorshipForAdmin: vi.fn() }));

const { getSponsorIntelligenceConfig, isSponsorIntelligenceEnabled } = await import("@/lib/sponsor-intelligence/service");

const ok = (over: Record<string, unknown> = {}) => ({
  data: { sponsor_intelligence_enabled: true, sponsor_intelligence_min_cohort: 10, sponsor_intelligence_affinity_lookback_days: 90, ...over },
  error: null,
});

beforeEach(() => {
  throwOnRead = false;
  settingsResult = ok();
});

describe("Sponsor Intelligence capability fails closed", () => {
  it("is ON only for a successfully read literal true", async () => {
    expect(await getSponsorIntelligenceConfig()).toEqual({ enabled: true, minCohort: 10, affinityLookbackDays: 90 });
    expect(await isSponsorIntelligenceEnabled()).toBe(true);
  });

  it("is OFF when the value is false", async () => {
    settingsResult = ok({ sponsor_intelligence_enabled: false });
    expect((await getSponsorIntelligenceConfig()).enabled).toBe(false);
  });

  it("is OFF for a missing row, a read error, a thrown client, or a non-literal true", async () => {
    settingsResult = { data: null, error: null };
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
    settingsResult = { data: null, error: { message: "boom" } };
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
    settingsResult = ok({ sponsor_intelligence_enabled: "true" });
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
    settingsResult = ok({ sponsor_intelligence_enabled: 1 });
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
    throwOnRead = true;
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
  });

  it("is OFF when the privacy threshold or look-back is malformed — it never runs with a missing privacy rule", async () => {
    for (const bad of [null, 0, 1, -3, 2.5, "10"]) {
      settingsResult = ok({ sponsor_intelligence_min_cohort: bad });
      expect(await isSponsorIntelligenceEnabled(), `min cohort ${String(bad)}`).toBe(false);
    }
    settingsResult = ok({ sponsor_intelligence_affinity_lookback_days: 0 });
    expect(await isSponsorIntelligenceEnabled()).toBe(false);
  });
});
