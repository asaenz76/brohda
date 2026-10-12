import { describe, expect, it } from "vitest";
import { paymentPhase } from "@/lib/sponsorship/payment-phase";
import { APPROVAL_STATUS_LABEL, paymentHeadline, paymentStateLabel } from "@/lib/sponsorship/format";

const ctx = { sponsorStatus: "ACTIVE", capabilityEnabled: true };

describe("when may a payment be asked of a Sponsor at all (the pure half of Pay now eligibility)", () => {
  it("a submitted, unpaid or failed sponsorship of an ACTIVE Sponsor, capability on → payable", () => {
    expect(paymentPhase({ lifecycle: "SUBMITTED", paymentStatus: "PENDING" }, ctx)).toEqual({ payable: true });
    expect(paymentPhase({ lifecycle: "SUBMITTED", paymentStatus: "FAILED" }, ctx)).toEqual({ payable: true });
  });

  it.each([
    ["a draft", { lifecycle: "DRAFT", paymentStatus: "UNPAID" }, "NOT_SUBMITTED"],
    ["already paid (still submitted)", { lifecycle: "SUBMITTED", paymentStatus: "PAID" }, "ALREADY_PAID"],
    ["paid and scheduled", { lifecycle: "SCHEDULED", paymentStatus: "PAID" }, "ALREADY_PAID"],
    ["refund pending", { lifecycle: "SUBMITTED", paymentStatus: "REFUND_PENDING" }, "ALREADY_PAID"],
    ["refunded", { lifecycle: "SUBMITTED", paymentStatus: "REFUNDED" }, "ALREADY_PAID"],
    ["cancelled", { lifecycle: "CANCELLED", paymentStatus: "PENDING" }, "CANCELLED_OR_ENDED"],
    ["completed", { lifecycle: "COMPLETED", paymentStatus: "PAID" }, "CANCELLED_OR_ENDED"],
    ["rejected", { lifecycle: "REJECTED", paymentStatus: "PENDING" }, "CANCELLED_OR_ENDED"],
    ["payment cancelled", { lifecycle: "SUBMITTED", paymentStatus: "CANCELLED" }, "NOT_PAYABLE_STATE"],
  ])("%s → not payable (%s)", (_name, s, reason) => {
    expect(paymentPhase(s, ctx)).toEqual({ payable: false, reason });
  });

  it.each(["PENDING_REVIEW", "REJECTED", "SUSPENDED", "DISABLED"])("a %s Sponsor account can't pay", (status) => {
    expect(paymentPhase({ lifecycle: "SUBMITTED", paymentStatus: "PENDING" }, { ...ctx, sponsorStatus: status })).toEqual({ payable: false, reason: "ACCOUNT_NOT_ACTIVE" });
  });

  it("capability OFF → no payment, whatever else is true", () => {
    expect(paymentPhase({ lifecycle: "SUBMITTED", paymentStatus: "PENDING" }, { ...ctx, capabilityEnabled: false })).toEqual({ payable: false, reason: "CAPABILITY_OFF" });
  });
});

describe("what a Sponsor reads about payment — truthful, one word plus one sentence", () => {
  it("the status word: a submitted sponsorship with no open attempt is Unpaid; with one it is Pending", () => {
    expect(paymentStateLabel("PENDING", false)).toBe("Unpaid");
    expect(paymentStateLabel("PENDING", true)).toBe("Pending");
    expect(paymentStateLabel("PAID", false)).toBe("Paid");
    expect(paymentStateLabel("FAILED", false)).toBe("Failed");
    expect(paymentStateLabel("REFUNDED", false)).toBe("Refunded");
    expect(paymentStateLabel("REFUND_PENDING", false)).toBe("Refund pending");
  });

  it("paid but unapproved says it is awaiting Brohda approval — never 'approved'", () => {
    const h = paymentHeadline({ paymentStatus: "PAID", lifecycle: "SUBMITTED", reviewStatus: "PENDING", openAttempt: false });
    expect(h).toBe("Payment received. Your sponsorship is awaiting Brohda approval.");
    expect(h).not.toMatch(/approved|scheduled|live/i);
  });

  it("paid and approved reads as scheduled or live according to the existing scheduling policy", () => {
    expect(paymentHeadline({ paymentStatus: "PAID", lifecycle: "SCHEDULED", reviewStatus: "APPROVED", openAttempt: false })).toBe("Payment received. Your sponsorship is approved and scheduled.");
    expect(paymentHeadline({ paymentStatus: "PAID", lifecycle: "LIVE", reviewStatus: "APPROVED", openAttempt: false })).toBe("Payment received. Your sponsorship is live.");
  });

  it("pending, failed and awaiting", () => {
    expect(paymentHeadline({ paymentStatus: "PENDING", lifecycle: "SUBMITTED", reviewStatus: "PENDING", openAttempt: true })).toBe("Payment pending.");
    expect(paymentHeadline({ paymentStatus: "PENDING", lifecycle: "SUBMITTED", reviewStatus: "PENDING", openAttempt: false })).toBe("Awaiting payment.");
    expect(paymentHeadline({ paymentStatus: "FAILED", lifecycle: "SUBMITTED", reviewStatus: "PENDING", openAttempt: false })).toBe("Payment failed — you can try again.");
  });

  it("approval has its own words, separate from payment", () => {
    expect(APPROVAL_STATUS_LABEL.PENDING).toBe("Awaiting review");
    expect(APPROVAL_STATUS_LABEL.APPROVED).toBe("Approved");
    expect(APPROVAL_STATUS_LABEL.REJECTED).toBe("Not approved");
  });
});
