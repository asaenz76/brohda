import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./test-env";

/**
 * Making a prediction the way a Member does now: choose a side (local), then tap a Confidence level — that tap IS the commitment, there is no separate confirm. Resolves once the card shows the committed, locked prediction.
 * `side` is the accessible name of the side button; `scope` is the card (or one Market's section) it lives in.
 */
export async function predict(scope: Locator | Page, side: string | RegExp, amount = 1) {
  await scope.getByRole("button", { name: side, exact: typeof side === "string" }).click();
  // .first(): a card whose other Markets are collapsed also holds their (hidden) composers; the one being used is the first in the DOM.
  await scope.locator(`[data-slot="confidence-choice"][data-amount="${amount}"]`).first().click();
  await expect(scope.locator('[data-slot="pick-confidence"], [data-slot="prediction-committed"]').first()).toBeVisible({ timeout: 30_000 });
}

/** A made prediction seeded through the SAME atomic function the app uses (side + Confidence + lock in one transaction), for specs that start from an existing prediction. Needs Confidence and predictions on (the E2E ambient default). */
export async function seedPrediction(userId: string, marketId: string, side: "YES" | "NO", amount = 1): Promise<string> {
  const admin = getTestAdminClient();
  await admin.rpc("confidence_bootstrap_member", { p_member_id: userId });
  const { data, error } = await admin.rpc("create_confidence_prediction", {
    p_user_id: userId,
    p_market_id: marketId,
    p_selected_outcome: side,
    p_amount: amount,
    p_yes_probability: 0.6,
    p_no_probability: 0.4,
    p_market_question: "q",
    p_market_close_at: null,
    p_market_status: "ACTIVE",
    p_idempotency_key: randomUUID(),
  });
  const row = data as { outcome: string; predictionId?: string } | null;
  if (error || !row || row.outcome !== "created" || !row.predictionId) throw new Error(`seedPrediction failed: ${error?.message ?? row?.outcome}`);
  return row.predictionId;
}
