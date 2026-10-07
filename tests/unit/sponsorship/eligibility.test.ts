import { describe, expect, it } from "vitest";
import { isSponsorshipPubliclyActive } from "@/lib/sponsorship/eligibility";
import type { SponsorshipEligibilityInputs } from "@/lib/sponsorship/types";

const NOW = new Date("2026-10-20T20:00:00Z");
const base = (o: Partial<SponsorshipEligibilityInputs> = {}): SponsorshipEligibilityInputs => ({
  id: "s1", postId: "p1", marketCode: "GLOBAL", lifecycle: "LIVE", paymentStatus: "PAID", reviewStatus: "APPROVED",
  startsAt: "2026-10-20T18:00:00Z", endsAt: "2026-10-21T02:00:00Z", approvalIntact: true, sponsorStatus: "ACTIVE", postPublished: true, fixtureStatus: "NOT_STARTED", hasDestination: true, ...o,
});
const active = (o: Partial<SponsorshipEligibilityInputs> = {}, enabled: unknown = true, now = NOW) => isSponsorshipPubliclyActive(base(o), { enabled, now });

describe("isSponsorshipPubliclyActive — the single public-eligibility policy", () => {
  it("paid + approved + enabled + inside its window renders (LIVE or still-SCHEDULED-by-label)", () => {
    expect(active()).toBe(true);
    expect(active({ lifecycle: "SCHEDULED" })).toBe(true); // the clock decides, not a label the cron has not updated yet
  });

  it("PAYMENT ALONE is never enough: paid but not approved (any review state) does not render", () => {
    for (const reviewStatus of ["PENDING", "REJECTED", "CHANGES_REQUESTED"] as const) expect(active({ reviewStatus })).toBe(false);
  });

  it("APPROVAL ALONE is never enough: approved but not paid (any payment state) does not render", () => {
    for (const paymentStatus of ["UNPAID", "PENDING", "FAILED", "REFUND_PENDING", "REFUNDED", "CANCELLED"] as const) expect(active({ paymentStatus })).toBe(false);
  });

  it("an approval that no longer matches the stored content does not render (approve-then-swap)", () => {
    expect(active({ approvalIntact: false })).toBe(false);
  });

  it.each(["DRAFT", "SUBMITTED", "SUSPENDED", "COMPLETED", "REJECTED", "CANCELLED"] as const)("lifecycle %s never renders, even when paid and approved", (lifecycle) => {
    expect(active({ lifecycle })).toBe(false);
  });

  it("the clock is checked here: a stored LIVE outside its window does not render", () => {
    expect(active({ lifecycle: "LIVE", endsAt: "2026-10-20T19:59:59Z" })).toBe(false);
    expect(active({ lifecycle: "LIVE", startsAt: "2026-10-20T20:00:01Z" })).toBe(false);
    expect(active({ endsAt: "2026-10-20T20:00:00Z" })).toBe(false); // end is exclusive
    expect(active({ startsAt: "2026-10-20T20:00:00Z" })).toBe(true); // start is inclusive
  });

  it("the capability must be exactly true — off, missing, malformed or unreadable all fail closed", () => {
    for (const enabled of [false, undefined, null, "true", 1, "on", {}, []]) expect(isSponsorshipPubliclyActive(base(), { enabled, now: NOW })).toBe(false);
  });

  it("an inactive sponsor does not render", () => {
    expect(active({ sponsorStatus: "SUSPENDED" })).toBe(false);
    expect(active({ sponsorStatus: "DISABLED" })).toBe(false);
  });

  it("geography: only markets the viewer is trusted to be in render; a country-level code is never shown without a location signal", () => {
    expect(active({ marketCode: "CR" })).toBe(false);
    expect(isSponsorshipPubliclyActive(base({ marketCode: "CR" }), { enabled: true, now: NOW, markets: ["GLOBAL", "CR"] })).toBe(true);
  });

  it("the canonical Post must still be published and its Game not cancelled/abandoned", () => {
    expect(active({ postPublished: false })).toBe(false);
    expect(active({ fixtureStatus: "CANCELLED" })).toBe(false);
    expect(active({ fixtureStatus: "ABANDONED" })).toBe(false);
    expect(active({ fixtureStatus: "LIVE" })).toBe(true); // an in-progress Game is exactly when a sponsor wants to be seen
    expect(active({ fixtureStatus: "COMPLETED" })).toBe(true); // the campaign window, not the result, ends it
  });

  it("a sponsorship with no approved destination does not render", () => {
    expect(active({ hasDestination: false })).toBe(false);
  });
});
