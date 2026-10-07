import { describe, expect, it } from "vitest";
import { formatCommercialAmount, sponsorCanEdit, sponsorStatusCopy } from "@/lib/sponsorship/format";
import { SponsorshipError, toSponsorshipError } from "@/lib/sponsorship/errors";
import { viewerMarkets } from "@/lib/sponsorship/geography";
import { sponsorLogoPublicUrl } from "@/lib/sponsorship/logo";

const s = (lifecycle: Parameters<typeof sponsorStatusCopy>[0]["lifecycle"], reviewStatus: Parameters<typeof sponsorStatusCopy>[0]["reviewStatus"], paymentStatus: Parameters<typeof sponsorStatusCopy>[0]["paymentStatus"]) => ({ lifecycle, reviewStatus, paymentStatus });

describe("sponsor-facing status copy keeps RECEIVED, DECIDED and HAPPENING apart", () => {
  it("paid but not approved says so — and never implies payment guarantees approval", () => {
    const c = sponsorStatusCopy(s("SUBMITTED", "PENDING", "PAID"));
    expect(c.label).toBe("Payment received — awaiting Brohda approval");
    expect(c.detail).toMatch(/does not guarantee approval/);
  });
  it("approved but unpaid is its own state", () => {
    expect(sponsorStatusCopy(s("SUBMITTED", "APPROVED", "PENDING")).label).toBe("Approved — awaiting payment");
  });
  it("scheduled and live are distinct from both", () => {
    expect(sponsorStatusCopy(s("SCHEDULED", "APPROVED", "PAID")).label).toBe("Approved and scheduled");
    expect(sponsorStatusCopy(s("LIVE", "APPROVED", "PAID")).label).toBe("Live");
  });
  it("every lifecycle has copy", () => {
    for (const l of ["DRAFT", "SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED", "COMPLETED", "REJECTED", "CANCELLED"] as const) expect(sponsorStatusCopy(s(l, "PENDING", "UNPAID")).label).toBeTruthy();
  });
  it("a sponsor may edit only a draft or a submission sent back for changes", () => {
    expect(sponsorCanEdit({ lifecycle: "DRAFT", reviewStatus: "PENDING" })).toBe(true);
    expect(sponsorCanEdit({ lifecycle: "SUBMITTED", reviewStatus: "CHANGES_REQUESTED" })).toBe(true);
    for (const lifecycle of ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED", "COMPLETED", "REJECTED", "CANCELLED"] as const) expect(sponsorCanEdit({ lifecycle, reviewStatus: "PENDING" })).toBe(false);
  });
});

describe("helpers", () => {
  it("formats in the sponsorship's own currency, never assuming USD", () => {
    expect(formatCommercialAmount(150000, "USD")).toBe("$1,500.00");
    expect(formatCommercialAmount(150000, "EUR")).toContain("€");
    expect(formatCommercialAmount(null, "USD")).toBe("—");
  });
  it("database error codes map to readable messages; unknown failures stay generic and leak nothing", () => {
    expect(toSponsorshipError({ message: "sponsorship_disabled" }).message).toMatch(/aren't open/);
    expect(toSponsorshipError({ message: 'permission denied for table "sponsorships" SQL...' }).message).toBe("Something went wrong. Try again.");
    expect(toSponsorshipError({ code: "23505", message: "duplicate key value violates unique constraint sponsorships_one_holder_per_inventory" })).toBeInstanceOf(SponsorshipError);
    expect(toSponsorshipError({ code: "23505", message: "dup" }).code).toBe("inventory_unavailable");
  });
  it("the only market a viewer may be shown today is GLOBAL (no trusted location signal exists)", () => {
    expect(viewerMarkets()).toEqual(["GLOBAL"]);
  });
  it("logo URLs come from the public bucket only", () => {
    expect(sponsorLogoPublicUrl("a/b.webp", "https://x.supabase.co")).toBe("https://x.supabase.co/storage/v1/object/public/sponsor-logos/a/b.webp");
    expect(sponsorLogoPublicUrl(null, "https://x.supabase.co")).toBeNull();
  });
});
