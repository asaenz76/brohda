"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toggleLeagueFollowSchema, updateLeagueFollowEmailSchema } from "@/lib/validations/team-follows";
import { checkLeagueFollowRateLimit } from "@/lib/rate-limit/team-follows";

export type ToggleLeagueFollowResult = { error: string | null; following: boolean };

// See lib/actions/team-follows.ts's revalidateTeamFollowSurfaces for the
// full reasoning — LeagueFollowToggle is equally fully optimistic locally,
// and the route segment is [id], not [poolId] (that used to silently no-op).
function revalidateLeagueFollowSurfaces() {
  revalidatePath("/pool/[id]", "page");
}

// Mirrors lib/actions/team-follows.ts's toggleTeamFollowAction exactly —
// see there for the full reasoning (service-role writes, requireUser()
// scoping, idempotent-toggle via the unique index).
export async function toggleLeagueFollowAction(
  leagueId: string,
  isCurrentlyFollowing: boolean,
): Promise<ToggleLeagueFollowResult> {
  const user = await requireUser();

  const parsed = toggleLeagueFollowSchema.safeParse({ leagueId });
  if (!parsed.success) {
    return { error: "Can't follow this league.", following: isCurrentlyFollowing };
  }

  const allowed = await checkLeagueFollowRateLimit(user.id);
  if (!allowed) {
    return { error: "Too many requests. Try again in a moment.", following: isCurrentlyFollowing };
  }

  const adminClient = createAdminClient();

  if (isCurrentlyFollowing) {
    const { error } = await adminClient
      .from("league_follows")
      .delete()
      .eq("user_id", user.id)
      .eq("league_id", parsed.data.leagueId);

    if (error) {
      return { error: "Could not unfollow this league.", following: true };
    }

    revalidateLeagueFollowSurfaces();
    return { error: null, following: false };
  }

  const { error } = await adminClient.from("league_follows").insert({
    user_id: user.id,
    league_id: parsed.data.leagueId,
  });

  // 23505 (unique_league_follow) means an earlier request already
  // succeeded — treat a retried follow as a success, not an error.
  if (error && error.code !== "23505") {
    return { error: "Could not follow this league.", following: false };
  }

  revalidateLeagueFollowSurfaces();
  return { error: null, following: true };
}

export type UpdateLeagueFollowEmailResult = { error: string | null };

export async function updateLeagueFollowEmailAction(
  leagueId: string,
  emailEnabled: boolean,
): Promise<UpdateLeagueFollowEmailResult> {
  const user = await requireUser();

  const parsed = updateLeagueFollowEmailSchema.safeParse({ leagueId, emailEnabled });
  if (!parsed.success) {
    return { error: "Could not update this preference." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("league_follows")
    .update({ email_enabled: parsed.data.emailEnabled })
    .eq("user_id", user.id)
    .eq("league_id", parsed.data.leagueId);

  if (error) {
    return { error: "Could not update this preference." };
  }

  revalidatePath("/profile");
  return { error: null };
}
