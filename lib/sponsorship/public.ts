import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSponsorshipEnabled } from "./capability";
import { isSponsorshipPubliclyActive } from "./eligibility";
import { sponsorLogoPublicUrl } from "./logo";
import type { PublicSponsorship, SponsorshipEligibilityInputs } from "./types";

// The public read path: which sponsorship (if any) each Game Post shows right now. Every candidate goes through the one eligibility policy, here, with the
// clock and the capability read at request time — never trusting a stored LIVE. What comes back is the minimal PublicSponsorship (no price, payment,
// review notes, contacts, internal name or raw destination).

/* eslint-disable @typescript-eslint/no-explicit-any */
function toInputs(r: any): SponsorshipEligibilityInputs {
  return {
    id: r.id,
    postId: r.post_id,
    marketCode: r.market_code,
    lifecycle: r.lifecycle,
    paymentStatus: r.payment_status,
    reviewStatus: r.review_status,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    approvalIntact: r.approval_intact === true,
    sponsorStatus: r.sponsor_status,
    postPublished: r.post_published === true,
    fixtureStatus: r.fixture_status,
    hasDestination: r.has_destination === true,
  };
}

function toPublic(r: any, now: Date): PublicSponsorship {
  const t = now.getTime();
  const promoOpen =
    r.has_promotion === true &&
    r.promotion_title &&
    r.official_rules_url &&
    r.promotion_fulfillment_name &&
    (!r.promotion_starts_at || new Date(r.promotion_starts_at).getTime() <= t) &&
    (!r.promotion_ends_at || t < new Date(r.promotion_ends_at).getTime());
  return {
    id: r.id,
    presentedBy: r.presented_by,
    tagline: r.tagline ?? null,
    ctaText: r.cta_text ?? null,
    logoUrl: sponsorLogoPublicUrl(r.logo_path),
    promotion: promoOpen
      ? {
          title: r.promotion_title,
          description: r.promotion_description ?? null,
          prizeDescription: r.prize_description ?? null,
          officialRulesUrl: r.official_rules_url,
          fulfillmentName: r.promotion_fulfillment_name,
          eligibilitySummary: r.promotion_eligibility_summary ?? null,
        }
      : null,
  };
}

export async function loadPublicSponsorships(postIds: string[], now: Date = new Date()): Promise<Map<string, PublicSponsorship>> {
  const result = new Map<string, PublicSponsorship>();
  if (postIds.length === 0) return result;
  const enabled = await isSponsorshipEnabled();
  if (!enabled) return result; // capability OFF (or unreadable): no query, no sponsorship, ever
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("sponsorship_eligibility_inputs")
      .select("*")
      .in("post_id", postIds)
      .in("lifecycle", ["SCHEDULED", "LIVE"]);
    if (error || !data) return result;
    for (const row of data) {
      if (!isSponsorshipPubliclyActive(toInputs(row), { enabled, now })) continue;
      if (!result.has(row.post_id)) result.set(row.post_id, toPublic(row, now)); // V1: one sponsor per Post
    }
  } catch {
    return new Map(); // unreadable -> nothing sponsored
  }
  return result;
}

/** The one active sponsorship (if any) for a single Post, for the Post detail page. */
export async function loadPublicSponsorshipForPost(postId: string, now: Date = new Date()): Promise<PublicSponsorship | null> {
  return (await loadPublicSponsorships([postId], now)).get(postId) ?? null;
}

/** Same eligibility, for a specific sponsorship id: used by the click redirect and impression recording. Returns the post id and the approved destination. */
export async function resolveActiveSponsorshipTarget(sponsorshipId: string, now: Date = new Date()): Promise<{ postId: string; destinationUrl: string } | null> {
  const enabled = await isSponsorshipEnabled();
  if (!enabled) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("sponsorship_eligibility_inputs").select("*").eq("id", sponsorshipId).maybeSingle();
    if (!data || !isSponsorshipPubliclyActive(toInputs(data), { enabled, now })) return null;
    const { data: s } = await admin.from("sponsorships").select("destination_url, promotion_destination_url").eq("id", sponsorshipId).single();
    if (!s?.destination_url) return null;
    return { postId: data.post_id, destinationUrl: s.destination_url };
  } catch {
    return null;
  }
}
