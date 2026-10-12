import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewQueue } from "@/components/sponsorship/ReviewQueue";
import { REVIEWABLE_SPONSORSHIP, REVIEWABLE_SPONSOR_STATUS, reviewTabLabel } from "@/lib/sponsorship/review-policy";
import type { SponsorRecord, SponsorshipRecord } from "@/lib/sponsorship/repository";

vi.mock("server-only", () => ({}));
afterEach(() => cleanup());

const sponsor = (o: Partial<SponsorRecord> = {}): SponsorRecord => ({ id: "s1", displayName: "Acme Sports", legalName: null, contactEmail: null, logoPath: null, logoUrl: null, website: "https://acme.example.com", country: "CR", contactName: "Ana", contactPhone: null, status: "PENDING_REVIEW", statusReason: null, reviewedAt: null, createdAt: "2026-10-01T12:00:00Z", ...o }) as SponsorRecord;
const sponsorship = (o: Partial<SponsorshipRecord> = {}): SponsorshipRecord =>
  ({ id: "p1", sponsorName: "Acme Sports", campaignName: "Launch", marketCode: "GLOBAL", game: { awayTeamName: "Ravens", homeTeamName: "Falcons", competitionName: "NFL", scheduledStartUtc: "2026-10-20T18:00:00Z" }, priceCents: 90000, currency: "USD", paymentStatus: "PENDING", lifecycle: "SUBMITTED", reviewStatus: "PENDING", ...o }) as unknown as SponsorshipRecord;

describe("the Review queue renders only review work", () => {
  it("nothing awaiting review → one concise empty state and nothing else", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[]} sponsorships={[]} />);
    expect(container.querySelector('[data-slot="review-empty"]')).toHaveTextContent("Nothing to review right now.");
    expect(container.querySelector("table, ul, section")).toBeNull();
    expect(container.textContent).not.toMatch(/None\./);
  });

  it("a pending Sponsor application is one row with a link to where the decision is made", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[sponsor()]} sponsorships={[]} />);
    const row = container.querySelector('[data-sponsor-id="s1"]')!;
    expect(row).toHaveTextContent("Acme Sports");
    expect(row.querySelector("a")).toHaveAttribute("href", "/admin/sponsorship/sponsors#sponsor-s1");
    expect(container.querySelector('[data-slot="review-sponsorships"]')).toBeNull(); // an empty section isn't rendered at all
    expect(container.querySelector('[data-slot="review-empty"]')).toBeNull();
  });

  it("a pending sponsorship request is one row linking to its admin page", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[]} sponsorships={[sponsorship()]} />);
    const row = container.querySelector('[data-sponsorship-id="p1"]')!;
    expect(row).toHaveTextContent("Ravens @ Falcons");
    expect(row.querySelector("a")).toHaveAttribute("href", "/admin/sponsorship/p1");
    expect(container.querySelector('[data-slot="review-sponsor-applications"]')).toBeNull();
  });

  it("both types together; each section shows its own count", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[sponsor(), sponsor({ id: "s2", displayName: "Beta" })]} sponsorships={[sponsorship()]} />);
    expect(container.querySelector('[data-slot="review-sponsor-applications"] h2')).toHaveTextContent("Sponsor applications (2)");
    expect(container.querySelector('[data-slot="review-sponsorships"] h2')).toHaveTextContent("Sponsorship requests (1)");
  });

  it("never renders configuration, legal, payment or status content", () => {
    const { container } = render(<ReviewQueue sponsorApplications={[sponsor()]} sponsorships={[sponsorship()]} />);
    expect(container.textContent).not.toMatch(/Sponsored Game Posts|Online sponsorship payments|provider|Sponsor Terms|Media and Advertising|refund cutoff|environment|configuration/i);
    expect(container.querySelector("select, input, form, button")).toBeNull();
  });
});

describe("what counts as reviewable is defined once, in canonical statuses", () => {
  it("Sponsor account: PENDING_REVIEW; Sponsorship: SUBMITTED + PENDING", () => {
    expect(REVIEWABLE_SPONSOR_STATUS).toBe("PENDING_REVIEW");
    expect(REVIEWABLE_SPONSORSHIP).toEqual({ lifecycle: "SUBMITTED", reviewStatus: "PENDING" });
  });
  it("the tab shows a count only when there is something to review", () => {
    expect(reviewTabLabel(0)).toBe("Review queue");
    expect(reviewTabLabel(3)).toBe("Review queue (3)");
  });
});

describe("one control surface per setting — enforced at the source", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const CARDS = ["OnlinePaymentsCard", "LegalStatusCard", "RefundPolicyCard", "OnlinePaymentsForm"];

  it("the Review queue page (and its component) pull in none of the configuration/status cards, and use the canonical queue queries — not a broad fetch filtered in the UI", () => {
    for (const f of ["app/(admin)/admin/sponsorship/page.tsx", "components/sponsorship/ReviewQueue.tsx"]) {
      const src = read(f);
      for (const c of CARDS) expect(src, `${f} must not use ${c}`).not.toContain(c);
      expect(src, f).not.toMatch(/isSponsorshipEnabled|getSponsorshipConfig|resolveOnlinePayment|getOnlinePaymentPolicy|registeredProviders/);
    }
    const page = read("app/(admin)/admin/sponsorship/page.tsx");
    expect(page).toContain("listSponsorshipsAwaitingReview");
    expect(page).toContain("listSponsorApplicationsAwaitingReview");
    expect(page).not.toContain("listAllSponsorships");
  });

  it("the other Sponsorship tabs don't render them either", () => {
    for (const f of ["app/(admin)/admin/sponsorship/campaigns/page.tsx", "app/(admin)/admin/sponsorship/inventory/page.tsx", "app/(admin)/admin/sponsorship/sponsors/page.tsx", "app/(admin)/admin/sponsorship/[id]/page.tsx", "app/(admin)/admin/sponsorship/sponsorship-nav.tsx"]) {
      const src = read(f);
      for (const c of ["OnlinePaymentsCard", "LegalStatusCard", "RefundPolicyCard"]) expect(src, `${f} must not use ${c}`).not.toContain(c);
    }
  });

  it("Settings → Brohda renders each of the moved cards exactly once", () => {
    const src = read("app/(admin)/admin/settings/brohda/page.tsx");
    for (const c of ["OnlinePaymentsCard", "RefundPolicyCard", "LegalStatusCard"]) expect(src.match(new RegExp(`<${c} />`, "g")), c).toHaveLength(1);
    expect(src).toContain("SponsorshipSettingsSection");
  });

  it("the moved cards read canonical sources (registry, policy, settings) — no copied status text", () => {
    const legal = read("components/sponsorship/LegalStatusCard.tsx");
    expect(legal).toContain("SPONSOR_TERMS_DOCUMENT");
    expect(legal).toContain("MEDIA_AGREEMENT_DOCUMENT");
    expect(legal).toContain("SPONSOR_PRIVACY_SECTION");
    expect(legal).not.toMatch(/DRAFT-1|2026-|January 1/);
    expect(read("components/sponsorship/RefundPolicyCard.tsx")).toContain("getSponsorshipConfig");
    expect(read("components/sponsorship/RefundPolicyCard.tsx")).not.toMatch(/\b12\b/);
  });

  it("Settings and the Review queue are Super Admin-only pages", () => {
    for (const f of ["app/(admin)/admin/settings/brohda/page.tsx", "app/(admin)/admin/sponsorship/page.tsx", "app/(admin)/admin/sponsorship/campaigns/page.tsx"]) expect(read(f), f).toContain("requireSuperAdmin()");
  });
});
