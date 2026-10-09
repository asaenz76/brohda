import { z } from "zod";
import { normalizeSafeUrl } from "@/lib/sponsorship/validation";

// What a Sponsor types when applying or editing its profile. Deliberately NOT here: username, bio, pronouns, gender, avatar, card or bank details — a Sponsor
// is a business, not a Member. The database re-checks lengths and the website scheme; this is the first, friendly layer.
export const SPONSOR_NEUTRAL_EMAIL_ERROR = "This email can't be used for a Sponsor account. Use a different business email.";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const optionalWebsite = z
  .string()
  .trim()
  .max(300)
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const normalized = normalizeSafeUrl(v.includes("://") ? v : `https://${v}`);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Enter a valid website address." });
      return z.NEVER;
    }
    return normalized;
  });

const optionalPhone = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    if (v.length < 3 || v.length > 40 || !/^[0-9+()\-.\s]+$/.test(v)) {
      ctx.addIssue({ code: "custom", message: "Enter a valid phone or WhatsApp number." });
      return z.NEVER;
    }
    return v;
  });

export const sponsorProfileFields = {
  brandName: z.string().trim().min(1, "Enter your brand or company name.").max(80, "Keep the name under 80 characters."),
  contactName: z.string().trim().min(1, "Enter the contact person's name.").max(120, "Keep the name under 120 characters."),
  website: optionalWebsite,
  country: optionalText(80),
  phone: optionalPhone,
};

export const sponsorSignupSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid business email.")),
    password: z.string().min(8, "Use at least 8 characters.").max(72, "Use at most 72 characters."),
    ...sponsorProfileFields,
  })
  .strict();
export type SponsorSignupInput = z.infer<typeof sponsorSignupSchema>;

export const sponsorProfileSchema = z.object(sponsorProfileFields).strict();
export type SponsorProfileInput = z.infer<typeof sponsorProfileSchema>;

export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] = out[key] ?? issue.message;
  }
  return out;
}
