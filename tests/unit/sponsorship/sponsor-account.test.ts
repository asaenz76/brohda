import { describe, expect, it } from "vitest";
import { fieldErrorsOf, sponsorProfileSchema, sponsorSignupSchema, SPONSOR_NEUTRAL_EMAIL_ERROR } from "@/lib/sponsor/validation";
import { sponsorAccountStatusCopy } from "@/lib/sponsor/status";
import { CURRENT_SPONSOR_TERMS } from "@/lib/sponsor/terms";
import { SPONSOR_STATUSES } from "@/lib/sponsorship/types";

const base = { email: "Biz@Example.com", password: "a-long-password", brandName: "  Acme Co  ", contactName: "Pat Doe" };

describe("sponsor signup validation", () => {
  it("requires business email, password, brand name and contact name — and nothing a Member profile has", () => {
    const r = sponsorSignupSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.email).toBe("biz@example.com");
      expect(r.data.brandName).toBe("Acme Co");
    }
    for (const missing of ["email", "password", "brandName", "contactName"] as const) {
      const input: Record<string, unknown> = { ...base };
      delete input[missing];
      expect(sponsorSignupSchema.safeParse(input).success, missing).toBe(false);
    }
  });

  it("does not accept Member-profile fields", () => {
    for (const extra of ["username", "bio", "pronouns", "gender", "avatar", "displayName", "cardNumber"]) {
      expect(sponsorSignupSchema.safeParse({ ...base, [extra]: "x" }).success, extra).toBe(false);
    }
  });

  it("does not reject a free-mail address or hard-code a domain blacklist", () => {
    for (const email of ["a@gmail.com", "b@outlook.com", "c@yahoo.com", "d@acme.example"]) expect(sponsorSignupSchema.safeParse({ ...base, email }).success, email).toBe(true);
  });

  it("optional website/country/phone are normalised or rejected sensibly", () => {
    const ok = sponsorSignupSchema.parse({ ...base, website: "acme.example/path", country: "Mexico", phone: "+52 (55) 1234-5678" });
    expect(ok.website).toBe("https://acme.example/path");
    expect(sponsorSignupSchema.safeParse({ ...base, website: "javascript:alert(1)" }).success).toBe(false);
    expect(sponsorSignupSchema.safeParse({ ...base, phone: "call me maybe" }).success).toBe(false);
    expect(sponsorSignupSchema.parse({ ...base, website: "", country: "", phone: "" })).not.toHaveProperty("website", "");
  });

  it("enforces password length and brand/contact bounds", () => {
    expect(sponsorSignupSchema.safeParse({ ...base, password: "short" }).success).toBe(false);
    expect(sponsorSignupSchema.safeParse({ ...base, password: "x".repeat(73) }).success).toBe(false);
    expect(sponsorSignupSchema.safeParse({ ...base, brandName: "x".repeat(81) }).success).toBe(false);
    expect(sponsorSignupSchema.safeParse({ ...base, brandName: "   " }).success).toBe(false);
  });

  it("field errors are reported per field", () => {
    const r = sponsorSignupSchema.safeParse({ ...base, email: "nope", brandName: "" });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrorsOf(r.error)).sort()).toEqual(["brandName", "email"]);
  });

  it("the profile schema has the same optional fields and no email/password", () => {
    expect(sponsorProfileSchema.safeParse({ brandName: "A", contactName: "B" }).success).toBe(true);
    expect(sponsorProfileSchema.safeParse({ brandName: "A", contactName: "B", email: "x@y.com" }).success).toBe(false);
  });

  it("the 'email taken' message is neutral: it names no account type", () => {
    expect(SPONSOR_NEUTRAL_EMAIL_ERROR).toBe("This email can't be used for a Sponsor account. Use a different business email.");
    expect(SPONSOR_NEUTRAL_EMAIL_ERROR).not.toMatch(/member|already|exists|registered/i);
  });
});

describe("sponsor account status copy", () => {
  it("covers every status, and only an ACTIVE account has commercial access", () => {
    for (const status of SPONSOR_STATUSES) {
      const copy = sponsorAccountStatusCopy(status, null);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.commercialAccess).toBe(status === "ACTIVE");
    }
  });

  it("a pending Sponsor can finish its profile; rejected/suspended/disabled cannot edit", () => {
    expect(sponsorAccountStatusCopy("PENDING_REVIEW", null).canEditProfile).toBe(true);
    for (const status of ["REJECTED", "SUSPENDED", "DISABLED"] as const) expect(sponsorAccountStatusCopy(status, null).canEditProfile).toBe(false);
  });

  it("shows the reason Super Admin gave, never an internal note", () => {
    expect(sponsorAccountStatusCopy("REJECTED", "Not a fit").detail).toContain("Not a fit");
    expect(sponsorAccountStatusCopy("SUSPENDED", null).detail).not.toContain("Reason:");
  });
});

describe("sponsor terms mechanism", () => {
  it("has no invented legal document: it is null until counsel approves one", () => {
    expect(CURRENT_SPONSOR_TERMS).toBeNull();
  });
});
