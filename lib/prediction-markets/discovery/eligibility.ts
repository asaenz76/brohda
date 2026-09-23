import type { MarketRecord } from "../repository";
import { deriveConsumerStatus } from "./status";

/**
 * Consumer discovery eligibility — deliberately distinct from, and layered
 * on top of, Milestone 1's ingestion eligibility (roadmap STEP 7):
 *
 *   Provider universe -> ingestion eligibility (lib/prediction-markets/eligibility.ts)
 *   -> normalized Brohda market catalog -> DISCOVERY eligibility (this file)
 *   -> consumer feed
 *
 * A market can be a perfectly valid, correctly-ingested catalog row and
 * still not belong in the main discovery feed (e.g. it has since closed).
 * This file never re-checks anything Milestone 1's ingestion layer already
 * guarantees (a valid provider id, a schema-valid shape) — it only adds the
 * consumer-facing question of "should this appear to a browsing user right
 * now."
 */

/** The main discovery feed: only markets a user can currently form a fresh opinion on. */
export function isFeedEligible(market: MarketRecord): boolean {
  if (!market.question?.trim()) return false;
  return deriveConsumerStatus(market.status, market.resolvedOutcome) === "ACTIVE";
}

/**
 * The market detail page is reachable for anything with a genuine consumer
 * status (ACTIVE, CLOSED, or RESOLVED) — a user who bookmarked or was
 * linked to a market that has since closed should see an honest closed/
 * resolved page, not a broken link. INACTIVE/ARCHIVED markets (no
 * consumer status at all) are not reachable — the detail page renders the
 * same honest "not found" state as a nonexistent id.
 */
export function isDetailReachable(market: MarketRecord): boolean {
  if (!market.question?.trim()) return false;
  return deriveConsumerStatus(market.status, market.resolvedOutcome) !== null;
}
