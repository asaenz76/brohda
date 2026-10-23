import "server-only";
import { cache } from "react";
import { getConfidenceConfig } from "./config";
import { createAdminClient } from "@/lib/supabase/admin";
import { readMemberConfidence } from "./service";
import type { ConfidenceOffer } from "./format";

/**
 * Everything a prediction card needs to compose a prediction, read once per page render (never per card): the configured ladder, the Member's available Confidence and whether a Daily Claim is open. Null while predictions
 * are unavailable — Confidence or backed predictions off, or no account. The same configuration and balance the rest of the product reads; it decides nothing about a specific prediction.
 */
export const getConfidenceOffer = cache(async (memberId: string): Promise<ConfidenceOffer | null> => {
  const config = await getConfidenceConfig();
  if (!config || !config.backedPicksEnabled) return null;
  // The caller passes the signed-in Member's id (from their session); reading with the service client keeps the feed independent of request cookies.
  const mine = await readMemberConfidence(memberId, createAdminClient());
  if (!mine) return null;
  return { available: mine.available, allowedStakes: config.allowedStakes, canClaim: mine.canClaim, twoStep: config.optionalPicksEnabled && config.twoStepComposerEnabled };
});
