import { describe, expect, it } from "vitest";
import { draftToDbFields, inventorySchema, normalizeSafeUrl, promotionProblems, sponsorshipDraftSchema } from "@/lib/sponsorship/validation";

describe("destination URL safety", () => {
  it.each([
    "https://acme.com",
    "https://acme.com/path?utm=1#x",
    "http://acme.co.uk/promo",
    "https://sub.acme.com:8443/a",
  ])("accepts %s", (u) => expect(normalizeSafeUrl(u)).not.toBeNull());

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "ftp://acme.com/x",
    "//acme.com",
    "acme.com",
    "https://user:pass@acme.com",
    "https://localhost/admin",
    "https://127.0.0.1/x",
    "https://printer.local/x",
    "https://acme.com/<script>",
    'https://acme.com/"onmouseover="x',
    "https://acme .com",
    "",
    "   ",
    `https://acme.com/${"a".repeat(2100)}`,
  ])("rejects %j", (u) => expect(normalizeSafeUrl(u)).toBeNull());
});

const draft = (o: Record<string, unknown> = {}) => ({ campaignName: "c", presentedBy: "Acme", hasPromotion: false, ...o });

describe("sponsorship draft schema", () => {
  it("normalizes a valid draft and turns blanks into nulls", () => {
    const r = sponsorshipDraftSchema.parse(draft({ tagline: "  ", destinationUrl: "https://acme.com" }));
    expect(r.tagline).toBeNull();
    expect(r.destinationUrl).toBe("https://acme.com/");
  });

  it("rejects a malicious destination or rules URL with a readable message", () => {
    const bad = sponsorshipDraftSchema.safeParse(draft({ destinationUrl: "javascript:alert(1)" }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toMatch(/https/);
    expect(sponsorshipDraftSchema.safeParse(draft({ hasPromotion: true, officialRulesUrl: "data:text/html,x" })).success).toBe(false);
  });

  it("enforces field limits (name 80, tagline 140, CTA 30)", () => {
    expect(sponsorshipDraftSchema.safeParse(draft({ presentedBy: "x".repeat(81) })).success).toBe(false);
    expect(sponsorshipDraftSchema.safeParse(draft({ tagline: "x".repeat(141) })).success).toBe(false);
    expect(sponsorshipDraftSchema.safeParse(draft({ ctaText: "x".repeat(31) })).success).toBe(false);
  });

  it("promotion fields are cleared when there is no promotion, so a stale prize can never ride along", () => {
    const parsed = sponsorshipDraftSchema.parse(draft({ hasPromotion: false, prizeDescription: "A car", officialRulesUrl: "https://acme.com/rules" }));
    const fields = draftToDbFields(parsed);
    expect(fields.prize_description).toBeNull();
    expect(fields.official_rules_url).toBeNull();
    expect(fields.has_promotion).toBe(false);
  });

  it("a promotion needs a title, description, official rules link and a named runner before it can be submitted", () => {
    const parsed = sponsorshipDraftSchema.parse(draft({ hasPromotion: true }));
    expect(promotionProblems(parsed)).toHaveLength(4);
    const ok = sponsorshipDraftSchema.parse(draft({ hasPromotion: true, promotionTitle: "t", promotionDescription: "d", officialRulesUrl: "https://acme.com/rules", promotionFulfillmentName: "Acme" }));
    expect(promotionProblems(ok)).toEqual([]);
  });
});

describe("inventory schema", () => {
  const ok = { postId: "0f4c1d3e-1b0a-4c11-9a4e-0b6f2a8d1c11", marketCode: "global", isSponsorable: true, priceCents: 1000, currency: "usd", startsAt: "2026-10-20T00:00:00Z", endsAt: "2026-10-21T00:00:00Z" };
  it("normalizes market and currency to upper case", () => {
    const r = inventorySchema.parse(ok);
    expect(r.marketCode).toBe("GLOBAL");
    expect(r.currency).toBe("USD");
  });
  it("rejects an end before the start, a negative or fractional price, and a bad currency", () => {
    expect(inventorySchema.safeParse({ ...ok, endsAt: ok.startsAt }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...ok, priceCents: -1 }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...ok, priceCents: 10.5 }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...ok, currency: "dollars" }).success).toBe(false);
  });
});
