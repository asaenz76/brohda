import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// A controllable stand-in for the service-role client: the settings read and the eligibility view.
let settingsResult: { data: unknown; error: unknown } = { data: { sponsorship_enabled: true }, error: null };
let throwOnCreate = false;
let viewRows: unknown[] = [];
let viewCalls = 0;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (throwOnCreate) throw new Error("no client");
    return {
      from: (table: string) => {
        if (table === "platform_settings") return { select: () => ({ eq: () => ({ single: async () => settingsResult }) }) };
        viewCalls++;
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.in = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: viewRows[0] ?? null, error: null });
        chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: viewRows, error: null });
        return chain;
      },
    };
  },
}));

const liveRow = (o: Record<string, unknown> = {}) => ({
  id: "s1", post_id: "p1", market_code: "GLOBAL", lifecycle: "LIVE", payment_status: "PAID", review_status: "APPROVED",
  starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: new Date(Date.now() + 3_600_000).toISOString(), approval_intact: true,
  sponsor_status: "ACTIVE", post_published: true, fixture_status: "NOT_STARTED", has_destination: true, presented_by: "Acme", tagline: null, cta_text: null, logo_path: null, has_promotion: false, ...o,
});

beforeEach(() => {
  settingsResult = { data: { sponsorship_enabled: true }, error: null };
  throwOnCreate = false;
  viewRows = [liveRow()];
  viewCalls = 0;
});

describe("sponsorship_enabled fails closed (missing / malformed / unreadable = OFF)", async () => {
  const { isSponsorshipEnabled } = await import("@/lib/sponsorship/capability");
  const { loadPublicSponsorships, resolveActiveSponsorshipTarget } = await import("@/lib/sponsorship/public");

  it("only a successfully read literal true is ON", async () => {
    expect(await isSponsorshipEnabled()).toBe(true);
    for (const data of [{ sponsorship_enabled: false }, { sponsorship_enabled: null }, { sponsorship_enabled: "true" }, { sponsorship_enabled: 1 }, {}, null]) {
      settingsResult = { data, error: null };
      expect(await isSponsorshipEnabled(), JSON.stringify(data)).toBe(false);
    }
    settingsResult = { data: { sponsorship_enabled: true }, error: { message: "boom" } };
    expect(await isSponsorshipEnabled()).toBe(false); // an error beats a value
    throwOnCreate = true;
    expect(await isSponsorshipEnabled()).toBe(false);
  });

  it("with the capability unreadable the public loader returns nothing — and never even queries sponsorships", async () => {
    settingsResult = { data: null, error: { message: "unreadable" } };
    expect((await loadPublicSponsorships(["p1"])).size).toBe(0);
    expect(viewCalls).toBe(0);
    expect(await resolveActiveSponsorshipTarget("s1")).toBeNull();
  });

  it("ON + a fully valid row renders; any single failed condition (stored LIVE notwithstanding) hides it", async () => {
    expect((await loadPublicSponsorships(["p1"])).get("p1")?.presentedBy).toBe("Acme");
    for (const bad of [{ payment_status: "PENDING" }, { review_status: "PENDING" }, { approval_intact: false }, { lifecycle: "SUSPENDED" }, { sponsor_status: "DISABLED" }, { ends_at: new Date(Date.now() - 1000).toISOString() }, { post_published: false }, { market_code: "CR" }]) {
      viewRows = [liveRow(bad)];
      expect((await loadPublicSponsorships(["p1"])).size, JSON.stringify(bad)).toBe(0);
    }
  });

  it("V1 shows one sponsor per Post even if two rows somehow qualify", async () => {
    viewRows = [liveRow({ id: "first", presented_by: "First" }), liveRow({ id: "second", presented_by: "Second" })];
    const result = await loadPublicSponsorships(["p1"]);
    expect(result.size).toBe(1);
    expect(result.get("p1")?.presentedBy).toBe("First");
  });

  it("a promotion renders only while its own window is open and only with rules + a named runner", async () => {
    const promo = { has_promotion: true, promotion_title: "Win", official_rules_url: "https://a.example/rules", promotion_fulfillment_name: "Acme" };
    viewRows = [liveRow(promo)];
    expect((await loadPublicSponsorships(["p1"])).get("p1")?.promotion?.title).toBe("Win");
    viewRows = [liveRow({ ...promo, promotion_ends_at: new Date(Date.now() - 1000).toISOString() })];
    expect((await loadPublicSponsorships(["p1"])).get("p1")?.promotion).toBeNull();
    viewRows = [liveRow({ ...promo, promotion_fulfillment_name: null })];
    expect((await loadPublicSponsorships(["p1"])).get("p1")?.promotion).toBeNull();
  });
});
