import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUsableSession, isSuperAdmin, isAdminOrAbove } from "./guards";

export type UserProfile = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  role: "super_admin" | "admin" | "player";
  is_active: boolean;
};

export async function getCurrentUser(): Promise<UserProfile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, display_name, username, avatar_url, role, is_active")
    .eq("id", user.id)
    .single();

  return profile as UserProfile | null;
}

export async function requireUser(): Promise<UserProfile> {
  const profile = await getCurrentUser();
  if (!isUsableSession(profile)) {
    redirect("/login");
  }
  return profile;
}

export async function requireSuperAdmin(): Promise<UserProfile> {
  const profile = await requireUser();
  if (!isSuperAdmin(profile)) {
    redirect("/feed");
  }
  return profile;
}

// Admin-panel page-level gate for anything that isn't money movement or
// account/role management — those stay behind requireSuperAdmin().
export async function requireAdminOrAbove(): Promise<UserProfile> {
  const profile = await requireUser();
  if (!isAdminOrAbove(profile)) {
    redirect("/feed");
  }
  return profile;
}
