"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { enterPoolSchema } from "@/lib/validations/pools";
import { checkEntryRateLimit } from "@/lib/rate-limit/entries";
import { broadcastPoolEntryAdded } from "@/lib/realtime/pool-updates";
import { createFollowerEntryNotifications } from "@/lib/notifications/create";

export type EnterPoolState = { error: string | null; success: boolean };

export async function enterPoolAction(
  _prevState: EnterPoolState,
  formData: FormData,
): Promise<EnterPoolState> {
  const user = await requireUser();

  // Admins/super_admins coordinate pools, they don't play in them — reject
  // before spending rate-limit budget on a request that can never succeed.
  // create_pool_entry rejects this too (defense in depth), so this check
  // and the "admin_cannot_enter_pool" branch below stay in agreement.
  if (isAdminOrAbove(user)) {
    return { error: "Admins cannot enter pools.", success: false };
  }

  const allowed = await checkEntryRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many attempts — wait a moment and try again.", success: false };
  }

  const parsed = enterPoolSchema.safeParse({
    poolId: formData.get("poolId"),
    optionId: formData.get("optionId"),
    amountCents: Number(formData.get("amountCents")),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "Something went wrong — try again.", success: false };
  }

  // create_pool_entry is REVOKEd from PUBLIC (service_role only) — the
  // requireUser() check above is what actually authorizes this call.
  const adminClient = createAdminClient();
  const { error } = await adminClient.rpc("create_pool_entry", {
    p_pool_id: parsed.data.poolId,
    p_user_id: user.id,
    p_option_id: parsed.data.optionId,
    p_amount: parsed.data.amountCents,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    if (error.message.includes("insufficient_balance")) {
      return { error: "You don't have enough balance for this entry.", success: false };
    }
    if (error.message.includes("pool_locked") || error.message.includes("pool_not_open")) {
      return { error: "This pool is no longer open for entries.", success: false };
    }
    if (error.message.includes("admin_cannot_enter_pool")) {
      return { error: "Admins cannot enter pools.", success: false };
    }
    if (error.message.includes("already_entered_tier_group")) {
      return { error: "You've already entered this pool at a different fee tier.", success: false };
    }
    return { error: "Could not submit your entry. Try again.", success: false };
  }

  revalidatePath("/feed");
  revalidatePath("/profile");
  revalidatePath(`/pool/${parsed.data.poolId}`);

  // Tell every other viewer already looking at this pool to refresh their
  // percentages/payout estimate — the acting user's own card gets fresh
  // data for free via Next's post-action route refresh, but nobody else
  // has any way to learn about this entry until they reload.
  await broadcastPoolEntryAdded(parsed.data.poolId);

  await createFollowerEntryNotifications({
    poolId: parsed.data.poolId,
    enteredUserId: user.id,
    enteredDisplayName: user.display_name,
  });

  return { error: null, success: true };
}
