import "server-only";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  username: string | null;
  pronouns: string | null;
  gender: string | null;
  bio: string | null;
}

// Not every user has set a username (e.g. some seed/demo accounts) — for
// those, callers (search results, followers/following lists, etc.) link
// by id instead, so any route keyed on this segment must accept either.
// Shared by /profile/[username], .../followers, and .../following so the
// three can't drift on how they resolve the segment.
export async function resolvePublicProfile(identifier: string): Promise<PublicProfile | null> {
  const supabase = await createClient();
  const columns = "id, display_name, avatar_url, username, pronouns, gender, bio";
  const { data } = await (UUID_PATTERN.test(identifier)
    ? supabase.from("public_profiles").select(columns).eq("id", identifier)
    : supabase.from("public_profiles").select(columns).eq("username", identifier)
  ).single();
  return data;
}
