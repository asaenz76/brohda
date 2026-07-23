"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { toggleLikeSchema } from "@/lib/validations/likes";
import { checkLikeRateLimit } from "@/lib/rate-limit/likes";

export type ToggleLikeResult = { error: string | null; liked: boolean };

// requireUser() scopes this to the caller's own id server-side. The actual
// insert-or-delete + counter update happens atomically inside
// toggle_pool_like() (service_role-only execute) — this action is just the
// auth/validation/rate-limit gate in front of it.
export async function toggleLikeAction(
  poolId: string,
  isCurrentlyLiked: boolean,
): Promise<ToggleLikeResult> {
  const user = await requireUser();

  const parsed = toggleLikeSchema.safeParse({ poolId });
  if (!parsed.success) {
    return { error: "Can't like this pool.", liked: isCurrentlyLiked };
  }

  const allowed = await checkLikeRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many requests. Try again in a moment.", liked: isCurrentlyLiked };
  }

  const adminClient = createAdminClient();
  const { data: liked, error } = await adminClient.rpc("toggle_pool_like", {
    p_pool_id: parsed.data.poolId,
    p_user_id: user.id,
  });

  if (error) {
    return { error: "Could not update your like.", liked: isCurrentlyLiked };
  }

  revalidatePath("/feed");
  revalidatePath("/profile");
  revalidatePath(`/pool/${parsed.data.poolId}`);
  return { error: null, liked: Boolean(liked) };
}
