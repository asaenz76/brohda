import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SponsorTermsDocument } from "@/components/legal/SponsorTermsDocument";
import { MEDIA_AGREEMENT_DOCUMENT, SPONSOR_TERMS_DOCUMENT } from "@/lib/sponsor/terms";
import { SponsorSignupForm } from "@/app/sponsor/(public)/signup/signup-form";

vi.mock("@/lib/actions/sponsor-account", () => ({ sponsorSignupAction: async () => ({ error: null }), resendSponsorVerificationAction: async () => ({ sent: true }) }));
afterEach(() => cleanup());

// Activation guard. A document may be marked APPROVED only when no counsel placeholder is left in its text — "[counsel …]", "[TBD]", "[DRAFT]",
// "[INSERT …]" — so an incomplete document can never become legally active by flipping one word. While a document is still DRAFT the placeholders are
// expected, and this test names them so nobody is surprised by what is still outstanding.
const PLACEHOLDER = /\[(?:counsel|owner|TBD|DRAFT|INSERT|Limitation)[^\]]*\]/gi;

describe("Sponsor legal documents can't be activated while placeholders remain", () => {
  const text = () => {
    const { container } = render(<SponsorTermsDocument refundCutoffHours={12} />);
    return (container.textContent ?? "").replace(/\s+/g, " ");
  };

  it("Sponsor Terms: APPROVED requires zero placeholders (and no draft banner); DRAFT carries the banner", () => {
    const body = text();
    const found = body.match(PLACEHOLDER) ?? [];
    if (SPONSOR_TERMS_DOCUMENT.status === "APPROVED") {
      expect(found, `Sponsor Terms are APPROVED but still contain placeholders: ${found.join(" | ")}`).toEqual([]);
      expect(body).not.toMatch(/DRAFT/);
      expect(SPONSOR_TERMS_DOCUMENT.version).not.toMatch(/DRAFT/);
      expect(SPONSOR_TERMS_DOCUMENT.effectiveDate).toBeTruthy();
    } else {
      expect(body).toContain("DRAFT — OWNER/COUNSEL REVIEW REQUIRED");
    }
  });

  it("the media agreement is guarded the same way (its own status, not inferred from the Sponsor Terms)", () => {
    const body = text();
    if (MEDIA_AGREEMENT_DOCUMENT.status === "APPROVED") {
      const section = body.slice(body.indexOf("Media and Advertising Agreement (per campaign)"));
      expect(section.match(PLACEHOLDER) ?? []).toEqual([]);
    } else {
      expect(MEDIA_AGREEMENT_DOCUMENT.effectiveDate).toBeNull();
    }
  });

  it("the refund section carries the owner-decided policy, with the configured hours", () => {
    const body = text();
    expect(body).toContain("at least 12 hours before the Game's scheduled start time");
    expect(body).toContain("After that the payment is non-refundable");
    expect(body).toMatch(/If Brohda rejects a sponsorship you have paid for, you are eligible for a full refund/);
    expect(body).toMatch(/full refund or replacement inventory/);
    expect(body).toMatch(/there is no refund unless Brohda materially failed to deliver/);
    expect(body).toMatch(/low engagement is not a failure to deliver/);
    expect(body).toMatch(/Suspending a campaign or a Sponsor account is not a refund/);
  });

  it("the placeholders still outstanding are exactly these (so the owner sees what blocks activation)", () => {
    if (SPONSOR_TERMS_DOCUMENT.status === "APPROVED") return;
    const found = (text().match(PLACEHOLDER) ?? []).map((p) => p.replace(/\s+/g, " "));
    expect(found).toEqual([
      "[counsel — payment terms]",
      "[counsel — complete list]",
      "[counsel — limitation of liability, disclaimers and indemnification to be provided]",
      "[Limitation of liability and indemnity — wording to be provided by counsel.]",
    ]);
  });
});

describe("Sponsor signup form: acceptance appears only for an APPROVED document", () => {
  it("no document → no checkbox", () => {
    const { container } = render(<SponsorSignupForm terms={null} />);
    expect(container.querySelector('input[name="acceptedTerms"]')).toBeNull();
  });

  it("an approved document → a required checkbox linking to the current Sponsor Terms", () => {
    const { container } = render(<SponsorSignupForm terms={{ key: "sponsor_terms", title: "Sponsor Terms", version: "2026-12-01", effectiveDate: "December 1, 2026", status: "APPROVED", href: "/sponsor/terms" }} />);
    const box = container.querySelector('input[name="acceptedTerms"]') as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(box.required).toBe(true);
    const link = container.querySelector('a[href="/sponsor/terms"]');
    expect(link?.textContent).toBe("Sponsor Terms");
    expect(container.textContent).toContain("effective December 1, 2026");
    // The form sends the box and nothing else about the document: the version is the server's.
    expect(container.querySelector('input[name="termsVersion"], input[name="version"]')).toBeNull();
  });
});
