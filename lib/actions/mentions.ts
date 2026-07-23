"use server";

import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export type MentionCandidate = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

// Prefix match, not substring — mirrors how every mention autocomplete
// (Instagram, Slack, etc.) narrows as you type, and lets the index on
// username actually be used instead of a full scan.
export async function searchUsersForMentionAction(query: string): Promise<MentionCandidate[]> {
  await requireUser();

  const prefix = query.trim().toLowerCase();
  if (prefix.length === 0) return [];

  const supabase = await createClient();
  const { data } = await supabase
    .from("public_profiles")
    .select("id, username, display_name, avatar_url")
    .not("username", "is", null)
    .ilike("username", `${prefix}%`)
    .order("username")
    .limit(6);

  return (data ?? []).map((p) => ({
    id: p.id,
    username: p.username as string,
    displayName: p.display_name,
    avatarUrl: p.avatar_url,
  }));
}
