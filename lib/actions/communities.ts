"use server";

import { requireUser } from "@/lib/auth/session";
import { followCommunity, unfollowCommunity } from "@/lib/communities/follows";

// Milestone R4 (§19, §36): `requireUser()` scopes every call to the
// caller's own id server-side — neither action accepts or trusts a
// client-supplied user id, so a user can never modify another user's
// follow relationship.

export async function followCommunityAction(communityId: string): Promise<{ error: string | null }> {
  const user = await requireUser();
  try {
    await followCommunity(user.id, communityId);
    return { error: null };
  } catch {
    return { error: "Could not follow this community." };
  }
}

export async function unfollowCommunityAction(communityId: string): Promise<{ error: string | null }> {
  const user = await requireUser();
  try {
    await unfollowCommunity(user.id, communityId);
    return { error: null };
  } catch {
    return { error: "Could not unfollow this community." };
  }
}
