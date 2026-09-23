import type { ConsumerMarketStatus } from "./types";

/**
 * The single, centralized place that decides how a normalized Milestone 1
 * status (ACTIVE/INACTIVE/CLOSED/ARCHIVED) becomes a consumer-facing status.
 * No component re-derives this (roadmap STEP 16: "status presentation rules
 * should be centralized, not reinvented per component").
 *
 * Returns null for INACTIVE/ARCHIVED — these are not discoverable consumer
 * states at all (a market Brohda hasn't confirmed is live, or one the
 * provider has stopped updating entirely); callers treat null as "this
 * market has no consumer-facing presentation."
 *
 * RESOLVED vs CLOSED is an honest distinction: a CLOSED market only becomes
 * RESOLVED once `resolvedOutcome` is genuinely non-null. Populating that
 * field automatically from real results is R3's own job
 * (docs/architecture/sports-prediction-network.md §12) — this function
 * never fabricates a result to make the distinction appear exercised
 * before a real resolution source exists.
 */
export function deriveConsumerStatus(status: string, resolvedOutcome: string | null): ConsumerMarketStatus | null {
  if (status === "ACTIVE") return "ACTIVE";
  if (status === "CLOSED") return resolvedOutcome != null ? "RESOLVED" : "CLOSED";
  return null;
}
