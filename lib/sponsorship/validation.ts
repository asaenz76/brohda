import { z } from "zod";

// Input validation for everything a sponsor (or Super Admin) types. The database re-checks URLs (is_safe_http_url) and lengths; this is the first,
// friendlier line, and it is stricter: URLs are parsed, not just pattern-matched.
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal)$/i;

/** http/https only, no credentials, a real public-looking host, bounded length. Returns the normalized URL or null. */
export function normalizeSafeUrl(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw || raw.length > 2048 || /[\s<>"]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".") || BLOCKED_HOST.test(url.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
  return url.toString();
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === undefined || v === "" ? null : v));

const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === "") return null;
    const normalized = normalizeSafeUrl(v);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Enter a full web address starting with https:// (or http://)." });
      return z.NEVER;
    }
    return normalized;
  });

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === "") return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date." });
      return z.NEVER;
    }
    return d.toISOString();
  });

export const sponsorshipDraftSchema = z.object({
  campaignName: z.string().trim().min(1, "Give the campaign a name.").max(120),
  presentedBy: z.string().trim().min(1, "Enter the name to show as the sponsor.").max(80),
  tagline: optionalText(140),
  ctaText: optionalText(30),
  destinationUrl: optionalUrl,
  hasPromotion: z.boolean(),
  promotionTitle: optionalText(120),
  promotionDescription: optionalText(600),
  prizeDescription: optionalText(300),
  officialRulesUrl: optionalUrl,
  promotionDestinationUrl: optionalUrl,
  promotionFulfillmentName: optionalText(160),
  promotionEligibilitySummary: optionalText(300),
  promotionStartsAt: optionalDate,
  promotionEndsAt: optionalDate,
});
export type SponsorshipDraftInput = z.infer<typeof sponsorshipDraftSchema>;

/** The jsonb the sponsor_update_sponsorship function takes (snake_case, only the editable columns). */
export function draftToDbFields(input: SponsorshipDraftInput): Record<string, unknown> {
  return {
    campaign_name: input.campaignName,
    presented_by: input.presentedBy,
    tagline: input.tagline,
    cta_text: input.ctaText,
    destination_url: input.destinationUrl,
    has_promotion: input.hasPromotion,
    promotion_title: input.hasPromotion ? input.promotionTitle : null,
    promotion_description: input.hasPromotion ? input.promotionDescription : null,
    prize_description: input.hasPromotion ? input.prizeDescription : null,
    official_rules_url: input.hasPromotion ? input.officialRulesUrl : null,
    promotion_destination_url: input.hasPromotion ? input.promotionDestinationUrl : null,
    promotion_fulfillment_name: input.hasPromotion ? input.promotionFulfillmentName : null,
    promotion_eligibility_summary: input.hasPromotion ? input.promotionEligibilitySummary : null,
    promotion_starts_at: input.hasPromotion ? input.promotionStartsAt : null,
    promotion_ends_at: input.hasPromotion ? input.promotionEndsAt : null,
  };
}

/** A promotion needs its title, rules link and the party that runs it before it can be submitted. */
export function promotionProblems(input: SponsorshipDraftInput): string[] {
  if (!input.hasPromotion) return [];
  const problems: string[] = [];
  if (!input.promotionTitle) problems.push("Give the promotion a title.");
  if (!input.promotionDescription) problems.push("Describe the promotion.");
  if (!input.officialRulesUrl) problems.push("Add the link to the official rules.");
  if (!input.promotionFulfillmentName) problems.push("Name who runs the promotion (the sponsor or its promotion administrator).");
  return problems;
}

export const inventorySchema = z
  .object({
    postId: z.uuid(),
    marketCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,16}$/, "Use letters, digits, - or _ (2-16 characters)."),
    isSponsorable: z.boolean(),
    priceCents: z.number().int().min(0).max(100_000_000),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code."),
    startsAt: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Enter a valid start."),
    endsAt: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), "Enter a valid end."),
  })
  .refine((v) => new Date(v.endsAt).getTime() > new Date(v.startsAt).getTime(), { message: "The campaign must end after it starts.", path: ["endsAt"] });
