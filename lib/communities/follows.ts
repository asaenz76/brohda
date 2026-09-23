import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R4 (§19-20): Community following — pure personalization/
// discovery signal, deliberately NOT the same thing as:
//   - `follows` (user-to-user social graph)
//   - `team_follows`/`league_follows` (private notification preferences,
//     R0.5's own finding — untouched, not reinterpreted here)
//   - declared public fandom (not implemented; §10 explicitly forbids
//     treating a follow as a public "I am a fan" statement)
//
// Every function here takes `userId` as a plain argument and enforces
// nothing about whose id it is — authorization ("only for yourself") is
// the caller's job (lib/actions/communities.ts's Server Actions, which
// always pass the current session's own user id, never a client-supplied
// one), exactly matching lib/posts/repository.ts's own division of
// responsibility.

export async function followCommunity(userId: string, communityId: string): Promise<"followed" | "already-following"> {
  const admin = createAdminClient();
  const { error } = await admin.from("community_follows").insert({ user_id: userId, community_id: communityId });
  if (!error) return "followed";
  if (error.code === "23505") return "already-following";
  throw error;
}

export async function unfollowCommunity(userId: string, communityId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("community_follows").delete().eq("user_id", userId).eq("community_id", communityId);
  if (error) throw error;
}

export async function isFollowingCommunity(userId: string, communityId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("community_follows").select("id").eq("user_id", userId).eq("community_id", communityId).maybeSingle();
  if (error) throw error;
  return data !== null;
}

export async function listFollowedCommunityIds(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("community_follows").select("community_id").eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => row.community_id);
}
