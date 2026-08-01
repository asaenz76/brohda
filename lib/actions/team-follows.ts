"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toggleTeamFollowSchema, updateTeamFollowEmailSchema } from "@/lib/validations/team-follows";
import { checkTeamFollowRateLimit } from "@/lib/rate-limit/team-follows";

export type ToggleTeamFollowResult = { error: string | null; following: boolean };

// TeamFollowToggle is already fully optimistic locally (flips its own icon
// on click, rolls back only on error) — /feed and /profile aren't
// revalidated here since that would just force an expensive
// getPoolCardViewModels recomputation to patch in state the client already
// shows correctly. /pool/[id] (note: the real route segment is [id], not
// [poolId] — this used to silently no-op) is kept as a cheap,
// single-pool eventual-consistency safety net.
function revalidateTeamFollowSurfaces() {
  revalidatePath("/pool/[id]", "page");
}

// requireUser() scopes this to the caller's own id server-side. Written via
// the service role, not a direct RLS INSERT/DELETE policy, matching
// lib/actions/follows.ts's toggleFollowAction — team_follows grants
// authenticated no insert/delete at all.
export async function toggleTeamFollowAction(
  teamId: string,
  isCurrentlyFollowing: boolean,
): Promise<ToggleTeamFollowResult> {
  const user = await requireUser();

  const parsed = toggleTeamFollowSchema.safeParse({ teamId });
  if (!parsed.success) {
    return { error: "Can't follow this team.", following: isCurrentlyFollowing };
  }

  const allowed = await checkTeamFollowRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many requests. Try again in a moment.", following: isCurrentlyFollowing };
  }

  const adminClient = createAdminClient();

  if (isCurrentlyFollowing) {
    const { error } = await adminClient
      .from("team_follows")
      .delete()
      .eq("user_id", user.id)
      .eq("team_id", parsed.data.teamId);

    if (error) {
      return { error: "Could not unfollow this team.", following: true };
    }

    revalidateTeamFollowSurfaces();
    return { error: null, following: false };
  }

  const { error } = await adminClient.from("team_follows").insert({
    user_id: user.id,
    team_id: parsed.data.teamId,
  });

  // 23505 (unique_team_follow) means an earlier request already succeeded —
  // treat a retried follow as a success, not an error.
  if (error && error.code !== "23505") {
    return { error: "Could not follow this team.", following: false };
  }

  revalidateTeamFollowSurfaces();
  return { error: null, following: true };
}

export type UpdateTeamFollowEmailResult = { error: string | null };

// Own-row RLS update (update_own_team_follow_email), not the service role —
// this is exactly what that policy/grant exists for, unlike the
// follow/unfollow toggle above.
export async function updateTeamFollowEmailAction(
  teamId: string,
  emailEnabled: boolean,
): Promise<UpdateTeamFollowEmailResult> {
  const user = await requireUser();

  const parsed = updateTeamFollowEmailSchema.safeParse({ teamId, emailEnabled });
  if (!parsed.success) {
    return { error: "Could not update this preference." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("team_follows")
    .update({ email_enabled: parsed.data.emailEnabled })
    .eq("user_id", user.id)
    .eq("team_id", parsed.data.teamId);

  if (error) {
    return { error: "Could not update this preference." };
  }

  revalidatePath("/profile");
  return { error: null };
}
