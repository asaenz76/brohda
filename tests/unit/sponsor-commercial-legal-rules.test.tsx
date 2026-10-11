import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SponsorTermsDocument } from "@/components/legal/SponsorTermsDocument";
import { PrivacyDocument } from "@/components/legal/PrivacyDocument";
import { legalRefundCutoffHours, MEDIA_AGREEMENT_DOCUMENT, SPONSOR_PRIVACY_SECTION, SPONSOR_TERMS_DOCUMENT, type SponsorLegalDocument } from "@/lib/sponsor/terms";
import { refundPolicyDiffersFromApprovedTerms } from "@/lib/sponsor/commercial-legal-gate";
import { legalRequirementCopy } from "@/lib/sponsor/legal-copy";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
afterEach(() => cleanup());

const APPROVED: SponsorLegalDocument = { ...SPONSOR_TERMS_DOCUMENT, status: "APPROVED", version: "1.0", effectiveDate: "January 1, 2027", refundCutoffHours: 12 };

describe("a refund cutoff belongs to the legal version, not to a database setting", () => {
  it("an APPROVED version shows ITS number whatever is configured; a draft shows the configured one", () => {
    expect(legalRefundCutoffHours(APPROVED, 2)).toBe(12);
    expect(legalRefundCutoffHours(SPONSOR_TERMS_DOCUMENT, 2)).toBe(2);
    expect(legalRefundCutoffHours({ ...APPROVED, refundCutoffHours: null }, 6)).toBe(6);
  });
  it("a configured cutoff that differs from the approved text is detected (and only then)", () => {
    expect(refundPolicyDiffersFromApprovedTerms(APPROVED, 12)).toBe(false);
    expect(refundPolicyDiffersFromApprovedTerms(APPROVED, 2)).toBe(true);
    expect(refundPolicyDiffersFromApprovedTerms(SPONSOR_TERMS_DOCUMENT, 2)).toBe(false); // a draft states nothing
    expect(refundPolicyDiffersFromApprovedTerms(null, 2)).toBe(false);
    expect(refundPolicyDiffersFromApprovedTerms({ ...APPROVED, refundCutoffHours: null }, 2)).toBe(false);
  });
  it("the value 12 is never written into product code outside the migration default, tests and the registry's own approved snapshot", () => {
    const files = ["lib/sponsorship/refund-policy.ts", "lib/sponsorship/refund-evaluation.ts", "lib/sponsorship/settings.ts", "components/legal/RefundTerms.tsx", "components/sponsorship/AgreementPanel.tsx", "lib/sponsor/commercial-legal-gate.ts"];
    for (const f of files) expect(readFileSync(f, "utf8").replace(/\/\/.*$/gm, "")).not.toMatch(/\b12\b/);
  });
});

describe("Sponsor-facing wording for a missing legal step is plain and provider-neutral", () => {
  it("names what to do, never a processor or legal text", () => {
    for (const m of [["SPONSOR_TERMS"], ["MEDIA_AGREEMENT"], ["REFUND_POLICY"]] as const) {
      const copy = legalRequirementCopy([...m]);
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).not.toMatch(/onvo|stripe|paypal|processor|provider/i);
    }
    expect(legalRequirementCopy(["SPONSOR_TERMS", "MEDIA_AGREEMENT"])).toMatch(/Sponsor Terms/); // the standing terms come first
  });
});

describe("registry statuses", () => {
  it("Sponsor Terms, the media agreement and the Sponsor privacy section are all explicit about their status (none is approved by engineering)", () => {
    expect(SPONSOR_TERMS_DOCUMENT.status).toBe("DRAFT");
    expect(MEDIA_AGREEMENT_DOCUMENT.status).toBe("DRAFT");
    expect(SPONSOR_PRIVACY_SECTION.status).toBe("DRAFT");
    expect(SPONSOR_TERMS_DOCUMENT.effectiveDate).toBeNull();
  });
});

describe("the Sponsor section of the Privacy Policy matches what the product actually does", () => {
  const section = () => {
    const { container } = render(<PrivacyDocument mode="active" />);
    const flat = (container.textContent ?? "").replace(/\s+/g, " ");
    const start = flat.indexOf("Sponsor accounts and sponsorships");
    return flat.slice(start, flat.indexOf("Third-party services", start));
  };
  it("covers every Sponsor field Brohda handles", () => {
    const t = section().toLowerCase();
    for (const field of ["business email", "company name", "contact person", "website", "country", "phone or whatsapp", "logo", "status of the application", "agreed price", "payment reference", "terms you accept", "audit trail", "has seen it", "follows its link"]) expect(t, field).toContain(field);
  });
  it("describes payment generically: third-party payment service providers, no processor named, no card or bank data stored", () => {
    const t = section();
    expect(t).toMatch(/do not collect or store card numbers or bank credentials/);
    expect(t).toMatch(/third-party payment service provider/);
    expect(t).not.toMatch(/onvo|stripe|paypal|sinpe|mercado/i);
    expect(t).not.toMatch(/sponsorship payments are arranged and confirmed outside the App/); // the old, now-incomplete claim
  });
  it("keeps the Member boundary and promises no Sponsor Intelligence", () => {
    const t = section();
    expect(t).toMatch(/Sponsors never receive information about individual Members/);
    expect(t).toMatch(/do not currently receive a reporting dashboard/);
    expect(t).not.toMatch(/intelligence|audience (report|insight)|analytics (dashboard|report)/i);
  });
});

describe("the draft Sponsor Terms state the commercial facts the product actually implements", () => {
  const text = () => {
    const { container } = render(<SponsorTermsDocument refundCutoffHours={12} />);
    return (container.textContent ?? "").replace(/\s+/g, " ");
  };
  it("payment: one or more methods, frozen price, pending or failed doesn't count, payment never approves — and no processor is named", () => {
    const t = text();
    expect(t).toMatch(/one or more methods, including online through a third-party payment service provider and offline arrangements/);
    expect(t).toMatch(/The price is the price fixed for your sponsorship when it was submitted/);
    expect(t).toMatch(/a payment that is pending or has failed does not count/);
    expect(t).toMatch(/Payment alone does not approve a sponsorship/);
    expect(t).not.toMatch(/onvo|stripe|paypal|sinpe/i);
  });
  it("approval, results and promotions: Super Admin approval is always required; no performance guarantee; Brohda runs no prize draws", () => {
    const t = text();
    expect(t).toMatch(/runs only when it is both paid and approved by Brohda/);
    expect(t).toMatch(/does not guarantee any level of visibility, clicks or results/);
    expect(t).toMatch(/does not run entries, choose winners or deliver prizes/);
    expect(t).toMatch(/Sponsors do not receive information about individual Members/);
  });
  it("cancellation: a Sponsor may cancel a submitted sponsorship and the refund terms decide the refund (matching the shipped 12-hour rule, not an older 'unpaid only' rule)", () => {
    const t = text();
    expect(t).toMatch(/A Sponsor may cancel a sponsorship it has submitted/);
    expect(t).not.toMatch(/may cancel a sponsorship that has not been paid/);
    expect(t).toMatch(/at least 12 hours before the Game's scheduled start time/);
    expect(t).toMatch(/Suspending a campaign or a Sponsor account is not a refund/);
  });
});
