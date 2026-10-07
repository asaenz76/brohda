import { viewerMarkets } from "./geography";
import type { SponsorshipEligibilityInputs } from "./types";

// THE one place that decides whether a sponsorship may render publicly. Every public surface (feed cards, Post detail, the click redirect, impression
// recording) calls this — there are no slightly different copies of these conditions in components.
//
// All of it must hold (any failure = nothing sponsored is shown; the canonical Game Post is unaffected either way):
//   1. the capability is ON (an unreadable/malformed setting is OFF);
//   2. payment stands                      (PAID — payment alone is never enough);
//   3. Super Admin approval stands         (APPROVED — approval alone is never enough) and still matches the stored content;
//   4. lifecycle is SCHEDULED or LIVE      (never DRAFT / SUBMITTED / SUSPENDED / REJECTED / CANCELLED / COMPLETED);
//   5. the campaign window is open         (checked against the clock HERE — a stale LIVE/SCHEDULED status is not trusted);
//   6. the sponsor is ACTIVE;
//   7. the viewer's market is covered;
//   8. the canonical Post is published and its Game was not cancelled/abandoned.
export interface SponsorshipEligibilityContext {
  /** The capability as read from platform_settings: only the literal `true` counts. */
  enabled: unknown;
  now: Date;
  markets?: readonly string[];
}

const DEAD_FIXTURE_STATUSES = new Set(["CANCELLED", "ABANDONED"]);

export function isSponsorshipPubliclyActive(s: SponsorshipEligibilityInputs, ctx: SponsorshipEligibilityContext): boolean {
  if (ctx.enabled !== true) return false;
  if (s.paymentStatus !== "PAID") return false;
  if (s.reviewStatus !== "APPROVED" || !s.approvalIntact) return false;
  if (s.lifecycle !== "SCHEDULED" && s.lifecycle !== "LIVE") return false;
  const t = ctx.now.getTime();
  if (!(new Date(s.startsAt).getTime() <= t && t < new Date(s.endsAt).getTime())) return false;
  if (s.sponsorStatus !== "ACTIVE") return false;
  if (!(ctx.markets ?? viewerMarkets()).includes(s.marketCode)) return false;
  if (!s.postPublished || DEAD_FIXTURE_STATUSES.has(s.fixtureStatus)) return false;
  if (!s.hasDestination) return false;
  return true;
}
