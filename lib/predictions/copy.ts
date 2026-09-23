import type { PredictionIneligibleReason } from "./types";

/**
 * Consumer-facing ineligibility copy (roadmap STEP 26) — no financial/
 * exchange terms, never a raw internal reason code or exception message.
 * Shared between the Server Action (lib/actions/predictions.ts) and the
 * market detail page's own pre-submission eligibility display, so the
 * wording is never duplicated (matching this codebase's existing
 * no-scattered-magic-values precedent from the Milestone 2 hard-coding
 * audit's FreshnessNote consolidation).
 *
 * A plain, synchronous module on purpose: a `"use server"` file may only
 * export async functions, so this copy table lives here instead of inside
 * the action itself.
 */
export function copyForIneligible(reason: PredictionIneligibleReason): string {
  switch (reason) {
    case "MARKET_NOT_FOUND":
      return "This market couldn't be found.";
    case "MARKET_RESOLVED":
      return "This market already has a result, so it can't be predicted on anymore.";
    case "MARKET_CLOSED":
      return "This market is closed to new predictions.";
    case "MARKET_INACTIVE":
      return "This market isn't open for predictions right now.";
    case "PRICE_UNAVAILABLE":
      return "The current chance isn't available right now, so this market can't be predicted on yet.";
    case "PRICE_STALE":
      return "This market's numbers haven't updated recently, so it isn't open for new predictions right now.";
    case "PAST_CUTOFF":
      return "It's too close to this market's close time to make a new prediction.";
    case "ALREADY_PREDICTED":
      return "You've already made a prediction on this market.";
    case "PICK_PAST_CUTOFF":
      return "Picks are locked for this game.";
    case "GAME_NOT_OPEN":
      return "This game has already started, so picks are locked.";
    case "PICK_LOCKED":
      return "Your pick is locked for this game.";
  }
}
