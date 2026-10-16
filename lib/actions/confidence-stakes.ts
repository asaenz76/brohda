"use server";

import { revalidatePath } from "next/cache";
import { requireMemberAccount } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConfidenceConfig } from "@/lib/confidence/config";
import { formatConfidence } from "@/lib/confidence/format";
import { isUuid } from "@/lib/messaging/share";

// Put Confidence behind the Member's OWN Pick. The server derives WHO is acting from the authenticated session — a client-supplied Member is never accepted — and the database function decides everything atomically
// (capability, ownership, the canonical Pick deadline and Game state, the configured ladder, availability, the reserve AND locking the Pick, in one transaction). The idempotency key makes a retried request return
// the original result instead of reserving again. Nothing here offers a way to get more Confidence: if there isn't enough, the answer says so and stops.

export interface AttachConfidenceResult {
  ok: boolean;
  outcome: string;
  message: string;
  amount?: number;
}

export async function attachConfidenceAction(input: { predictionId: string; amount: number; idempotencyKey: string }): Promise<AttachConfidenceResult> {
  const user = await requireMemberAccount();
  const error = (message: string, outcome = "error"): AttachConfidenceResult => ({ ok: false, outcome, message });
  if (!isUuid(input.predictionId) || !Number.isInteger(input.amount) || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 100) {
    return error("Something went wrong. Try again.");
  }
  // Fail closed in the action as well as in the database.
  const config = await getConfidenceConfig();
  if (!config || !config.backedPicksEnabled) return error("That isn't available right now.", "disabled");

  const { data, error: rpcError } = await createAdminClient().rpc("confidence_attach_stake", {
    p_member_id: user.id,
    p_prediction_id: input.predictionId,
    p_amount: input.amount,
    p_idempotency_key: input.idempotencyKey,
  });
  if (rpcError || !data) return error("Something went wrong. Try again.");
  const row = data as { outcome: string; amount?: number; available?: number };
  // The balance in the shell, the Pick card and the profile all change: refresh the whole signed-in layout.
  revalidatePath("/", "layout");
  switch (row.outcome) {
    case "attached":
      return { ok: true, outcome: "attached", message: `${formatConfidence(row.amount ?? input.amount)} behind your pick. It's locked in.`, amount: row.amount ?? input.amount };
    case "insufficient":
      return error(`You only have ${formatConfidence(row.available ?? 0)} available.`, "insufficient");
    case "invalid_amount":
      return error("That isn't one of the choices right now.", "invalid_amount");
    case "already_backed":
      return error("You've already put Confidence behind this pick.", "already_backed");
    case "past_deadline":
    case "game_started":
    case "pick_graded":
      return error("Confidence can't be added anymore — picks are locked for this game.", row.outcome);
    default:
      return error("That isn't available right now.", row.outcome);
  }
}
