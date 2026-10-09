import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { loginHrefFor, REQUEST_PATH_HEADER } from "@/lib/auth/safe-next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUsableSession, isSuperAdmin, isAdminOrAbove } from "./guards";
import { getAccountContext } from "./account";
import { SPONSOR_HOME } from "./account-routing";

export type UserProfile = {
  id: string;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  role: "super_admin" | "admin" | "player";
  is_active: boolean;
};

// cache()-wrapped so the layout, a page, and anything else calling
// requireUser()/requireAdminOrAbove()/requireSuperAdmin() within the same
// RSC render pass share one auth+profile lookup instead of each re-querying
// from scratch — proxy.ts's own middleware check is a separate phase of the
// request lifecycle and isn't affected by (or mergeable with) this.
export const getCurrentUser = cache(async (): Promise<UserProfile | null> => {
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
});

/**
 * The canonical Member guard: a signed-in, active MEMBER account (a positive check on the server-owned account type, not just "has a profile"). A Sponsor
 * session is sent to the Sponsor area — never shown anything Member-side, and never bounced through the Member login. Everything that was `requireUser()`
 * is this.
 */
export async function requireMemberAccount(): Promise<UserProfile> {
  const profile = await getCurrentUser();
  if (!isUsableSession(profile)) {
    if ((await getAccountContext())?.accountType === "SPONSOR") redirect(SPONSOR_HOME);
    // Send them to sign in and then straight back to the page they asked for (the proxy forwards that path; it is sanitised again here,
    // so a bad value just yields the plain /login).
    const requested = (await headers()).get(REQUEST_PATH_HEADER);
    redirect(loginHrefFor(requested));
  }
  if ((await getAccountContext())?.accountType !== "MEMBER") redirect(loginHrefFor(null));
  return profile;
}

export const requireUser = requireMemberAccount;

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
