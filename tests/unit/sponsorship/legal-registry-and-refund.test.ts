import { describe, expect, it } from "vitest";
import { CURRENT_MEDIA_AGREEMENT, CURRENT_SPONSOR_TERMS, MEDIA_AGREEMENT_DOCUMENT, requiredDocument, SPONSOR_TERMS_DOCUMENT, type SponsorLegalDocument } from "@/lib/sponsor/terms";
import { applicableRefundReasons, caseForReason, REFUND_CASES, refundCutoffRuleCopy, sponsorCancellationConsequence, type RefundContext, type RefundEvaluation } from "@/lib/sponsorship/refund-policy";

describe("Sponsor legal registry: a draft binds nobody", () => {
  it("both documents ship as DRAFT, so nothing is required and no acceptance UI is switched on", () => {
    expect(SPONSOR_TERMS_DOCUMENT.status).toBe("DRAFT");
    expect(MEDIA_AGREEMENT_DOCUMENT.status).toBe("DRAFT");
    expect(CURRENT_SPONSOR_TERMS).toBeNull();
    expect(CURRENT_MEDIA_AGREEMENT).toBeNull();
    expect(SPONSOR_TERMS_DOCUMENT.effectiveDate).toBeNull(); // a draft has no effective date
  });

  it("a document becomes required only when it is APPROVED", () => {
    const approved: SponsorLegalDocument = { ...SPONSOR_TERMS_DOCUMENT, status: "APPROVED", version: "2026-11-01", effectiveDate: "November 1, 2026" };
    expect(requiredDocument(approved)).toBe(approved);
    expect(requiredDocument({ ...approved, status: "DRAFT" })).toBeNull();
  });

  it("Sponsor documents are separate from the Member documents and have their own routes", () => {
    expect(SPONSOR_TERMS_DOCUMENT.key).toBe("sponsor_terms");
    expect(SPONSOR_TERMS_DOCUMENT.href).toBe("/sponsor/terms");
    expect(MEDIA_AGREEMENT_DOCUMENT.key).not.toBe(SPONSOR_TERMS_DOCUMENT.key);
  });
});

const base: RefundContext = { lifecycle: "SUBMITTED", reviewStatus: "PENDING", paymentStatus: "PAID", startsAt: new Date(Date.now() + 86_400_000).toISOString(), fixtureStatus: "NOT_STARTED" };

describe("refund policy V1: which causes apply (guidance only — the database decides eligibility)", () => {
  it("covers cases A–G", () => {
    expect(Object.keys(REFUND_CASES)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("nothing received → nothing to refund", () => {
    for (const paymentStatus of ["UNPAID", "PENDING", "FAILED", "CANCELLED"] as const) expect(applicableRefundReasons({ ...base, paymentStatus }), paymentStatus).toEqual([]);
  });

  it("Brohda rejected a paid sponsorship → A", () => {
    expect(applicableRefundReasons({ ...base, lifecycle: "REJECTED", reviewStatus: "REJECTED" })).toEqual(["BROHDA_REJECTED"]);
    expect(caseForReason("BROHDA_REJECTED", { reviewStatus: "REJECTED" })).toBe("A");
  });

  it("a submitted/scheduled sponsorship can be cancelled by its Sponsor — B before approval, C after", () => {
    expect(applicableRefundReasons({ ...base, lifecycle: "SUBMITTED", reviewStatus: "PENDING" })).toContain("SPONSOR_CANCELLATION");
    expect(caseForReason("SPONSOR_CANCELLATION", { reviewStatus: "PENDING" })).toBe("B");
    expect(caseForReason("SPONSOR_CANCELLATION", { reviewStatus: "APPROVED" })).toBe("C");
    expect(applicableRefundReasons({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED" })).toEqual(expect.arrayContaining(["SPONSOR_CANCELLATION", "BROHDA_CANCELLED_NO_BREACH"]));
  });

  it("a live suspension shows BOTH causes — Sponsor breach (no automatic refund) and a Brohda-caused interruption (undelivered portion) — so Super Admin states which", () => {
    const started = new Date(Date.now() - 3_600_000).toISOString();
    for (const lifecycle of ["SUSPENDED", "LIVE"] as const) {
      const r = applicableRefundReasons({ ...base, lifecycle, reviewStatus: "APPROVED", startsAt: started });
      expect(r).toEqual(expect.arrayContaining(["SPONSOR_BREACH", "BROHDA_LIVE_INTERRUPTION"]));
    }
    expect(caseForReason("SPONSOR_BREACH", { reviewStatus: "APPROVED" })).toBe("E");
  });

  it("a Game that cannot deliver → F", () => {
    for (const fixtureStatus of ["CANCELLED", "POSTPONED", "ABANDONED", "SUSPENDED"]) expect(applicableRefundReasons({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED", fixtureStatus }), fixtureStatus).toContain("GAME_UNDELIVERABLE");
    expect(applicableRefundReasons({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED", fixtureStatus: "NOT_STARTED" })).not.toContain("GAME_UNDELIVERABLE");
  });

  it("completed → G (delivered, unless Brohda failed to deliver)", () => {
    const r = applicableRefundReasons({ ...base, lifecycle: "COMPLETED", reviewStatus: "APPROVED", startsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(r).toEqual(["COMPLETED_DELIVERED", "BROHDA_NON_DELIVERY"]);
  });
});

describe("refund wording comes from the configured cutoff — there is no number in the policy file", () => {
  it("the Sponsor-facing rule uses whatever hours it is given", () => {
    expect(refundCutoffRuleCopy(12)).toBe("Refunds for Sponsor-initiated cancellations are available only when the Sponsorship is cancelled at least 12 hours before scheduled Game kickoff.");
    expect(refundCutoffRuleCopy(6)).toContain("at least 6 hours before");
    expect(refundCutoffRuleCopy(1)).toContain("at least 1 hour before");
    expect(REFUND_CASES.B.rule(24)).toContain("24 hours");
    expect(REFUND_CASES.A.rule(24)).not.toMatch(/\d+ hours/); // the cutoff does not apply to a Brohda rejection
  });

  it("the policy and evaluation modules never hard-code the cutoff", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["lib/sponsorship/refund-policy.ts", "lib/sponsorship/refund-evaluation.ts", "components/sponsorship/CancelSponsorshipPanel.tsx", "components/sponsorship/RefundGuidance.tsx", "components/legal/RefundTerms.tsx"]) {
      const code = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `${file} mentions a literal 12`).not.toMatch(/(?<![\w.-])12(?![\w-])/);
    }
  });
});

const evalOf = (over: Partial<RefundEvaluation>): RefundEvaluation => ({ eligible: true, reasonCode: "SPONSOR_CANCELLED_BEFORE_CUTOFF", reason: "SPONSOR_CANCELLATION", moneyReceived: true, kickoffAt: "2030-01-01T00:00:00Z", cutoffHours: 12, cutoffAt: "2029-12-31T12:00:00Z", evaluatedAt: "2029-12-30T00:00:00Z", requiresChoice: false, options: [], ...over });

describe("what a Sponsor is told before cancelling", () => {
  it("eligible: says so, and that processing is separate", () => {
    const c = sponsorCancellationConsequence(evalOf({}));
    expect(c.refundEligible).toBe(true);
    expect(c.headline).toBe("This cancellation is currently refund-eligible.");
    expect(c.detail).toMatch(/not mean automatic|separately/i);
  });

  it("inside the cutoff: says plainly that it is not eligible and that the Game is still released", () => {
    const c = sponsorCancellationConsequence(evalOf({ eligible: false, reasonCode: "SPONSOR_CANCELLED_INSIDE_CUTOFF" }));
    expect(c.refundEligible).toBe(false);
    expect(c.headline).toBe("This cancellation is not eligible for a refund.");
    expect(c.detail).toMatch(/non-refundable/);
    expect(c.detail).toMatch(/releases the Game/);
  });

  it("nothing paid: nothing to refund", () => {
    expect(sponsorCancellationConsequence(evalOf({ moneyReceived: false })).headline).toMatch(/nothing to refund/);
  });
});
