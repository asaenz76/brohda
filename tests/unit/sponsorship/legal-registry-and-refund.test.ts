import { describe, expect, it } from "vitest";
import { CURRENT_MEDIA_AGREEMENT, CURRENT_SPONSOR_TERMS, MEDIA_AGREEMENT_DOCUMENT, requiredDocument, SPONSOR_TERMS_DOCUMENT, type SponsorLegalDocument } from "@/lib/sponsor/terms";
import { candidateRefundCases, REFUND_CASES, REFUND_POLICY_STATUS, type RefundContext } from "@/lib/sponsorship/refund-policy";

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

describe("refund policy guidance (never an action)", () => {
  it("is proposed, not approved", () => {
    expect(REFUND_POLICY_STATUS).toMatch(/OWNER DECISION REQUIRED/);
    expect(Object.keys(REFUND_CASES)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("nothing is received → nothing to refund", () => {
    for (const paymentStatus of ["UNPAID", "PENDING", "FAILED", "CANCELLED"] as const) expect(candidateRefundCases({ ...base, paymentStatus }), paymentStatus).toEqual([]);
  });

  it("A paid campaign Brohda rejected", () => {
    expect(candidateRefundCases({ ...base, lifecycle: "REJECTED", reviewStatus: "REJECTED" })).toEqual(["A"]);
  });

  it("B a Sponsor cancelling before approval", () => {
    expect(candidateRefundCases({ ...base, lifecycle: "SUBMITTED", reviewStatus: "PENDING" })).toContain("B");
    expect(candidateRefundCases({ ...base, lifecycle: "CANCELLED", reviewStatus: "PENDING" })).toContain("B");
  });

  it("C/D approved but not started", () => {
    const c = candidateRefundCases({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED" });
    expect(c).toEqual(expect.arrayContaining(["C", "D"]));
    expect(candidateRefundCases({ ...base, lifecycle: "SUSPENDED", reviewStatus: "APPROVED" })).toContain("D");
  });

  it("E started, then suspended (or live)", () => {
    const started = new Date(Date.now() - 3_600_000).toISOString();
    expect(candidateRefundCases({ ...base, lifecycle: "SUSPENDED", reviewStatus: "APPROVED", startsAt: started })).toContain("E");
    expect(candidateRefundCases({ ...base, lifecycle: "LIVE", reviewStatus: "APPROVED", startsAt: started })).toContain("E");
  });

  it("F the Game cannot deliver", () => {
    for (const fixtureStatus of ["CANCELLED", "POSTPONED", "ABANDONED", "SUSPENDED"]) expect(candidateRefundCases({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED", fixtureStatus }), fixtureStatus).toContain("F");
    expect(candidateRefundCases({ ...base, lifecycle: "SCHEDULED", reviewStatus: "APPROVED", fixtureStatus: "NOT_STARTED" })).not.toContain("F");
  });

  it("G completed", () => {
    expect(candidateRefundCases({ ...base, lifecycle: "COMPLETED", reviewStatus: "APPROVED", startsAt: new Date(Date.now() - 86_400_000).toISOString() })).toEqual(["G"]);
  });
});
