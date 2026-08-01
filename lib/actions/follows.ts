"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { toggleFollowSchema } from "@/lib/validations/follows";
import { checkFollowRateLimit } from "@/lib/rate-limit/follows";

export type ToggleFollowResult = { error: string | null; following: boolean };

// A follow/unfollow changes counts and button state on the profile itself
// and its followers/following lists — every surface that reads
// get_follow_counts/is_following or renders a FollowButton. Not the acting
// user's own /profile: FollowButton is already fully optimistic locally
// (lib/components/profile/FollowButton.tsx flips state on click, rolls
// back only on error), and /profile's Predictions tab fetch is expensive
// (getPoolCardViewModels) for a page this toggle doesn't otherwise affect.
function revalidateFollowSurfaces() {
  revalidatePath("/profile/[username]", "page");
  revalidatePath("/profile/[username]/followers", "page");
  revalidatePath("/profile/[username]/following", "page");
}

// requireUser() scopes this to the caller's own id server-side — the
// client only ever says who to (un)follow, never who's doing the
// following. Written via the service role, not a direct RLS INSERT/DELETE
// policy, matching every other "caller acts as themselves" table here.
export async function toggleFollowAction(
  followeeId: string,
  isCurrentlyFollowing: boolean,
): Promise<ToggleFollowResult> {
  const user = await requireUser();

  const parsed = toggleFollowSchema.safeParse({ followeeId });
  if (!parsed.success || parsed.data.followeeId === user.id) {
    return { error: "Can't follow this profile.", following: isCurrentlyFollowing };
  }

  const allowed = await checkFollowRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many requests. Try again in a moment.", following: isCurrentlyFollowing };
  }

  const adminClient = createAdminClient();

  if (isCurrentlyFollowing) {
    const { error } = await adminClient
      .from("follows")
      .delete()
      .eq("follower_id", user.id)
      .eq("followee_id", parsed.data.followeeId);

    if (error) {
      return { error: "Could not unfollow this profile.", following: true };
    }

    revalidateFollowSurfaces();
    return { error: null, following: false };
  }

  const { error } = await adminClient.from("follows").insert({
    follower_id: user.id,
    followee_id: parsed.data.followeeId,
  });

  // 23505 (unique_follow) means an earlier request already succeeded —
  // treat a retried follow as a success, not an error.
  if (error && error.code !== "23505") {
    return { error: "Could not follow this profile.", following: false };
  }

  revalidateFollowSurfaces();
  return { error: null, following: true };
}
