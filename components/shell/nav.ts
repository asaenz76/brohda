import { Bell, Compass, Home, Search, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// The authenticated app's navigation, defined once and read by both the
// desktop left rail and the mobile bottom bar so the two can never drift.
// Every href is an existing route — nothing here introduces a destination.
//
// There is deliberately no "Create"/"New post" entry: Game Posts are
// published by Brohda only, so a member has nothing to create.
export type ShellNavKey = "home" | "discovery" | "notifications" | "search" | "profile" | "wallet";

export interface ShellNavItem {
  key: ShellNavKey;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Hidden when the social product is off (a UX signal only — each page enforces its own access). */
  socialGated?: boolean;
}

export const HOME_NAV: ShellNavItem = { key: "home", label: "Home", href: "/feed", icon: Home };
export const DISCOVERY_NAV: ShellNavItem = { key: "discovery", label: "Discovery", href: "/discovery", icon: Compass, socialGated: true };
export const NOTIFICATIONS_NAV: ShellNavItem = { key: "notifications", label: "Notifications", href: "/notifications", icon: Bell };
export const SEARCH_NAV: ShellNavItem = { key: "search", label: "Search", href: "/search", icon: Search };
export const PROFILE_NAV: ShellNavItem = { key: "profile", label: "Profile", href: "/profile", icon: User };

/** Desktop left rail, in order. Wallet is not here: it's a utility and lives in the rail's lower section. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [HOME_NAV, DISCOVERY_NAV, NOTIFICATIONS_NAV, SEARCH_NAV, PROFILE_NAV];

/** Mobile bottom bar, in order (a Menu button follows). Search lives in the menu on phones. */
export const MOBILE_NAV: readonly ShellNavItem[] = [HOME_NAV, DISCOVERY_NAV, NOTIFICATIONS_NAV, PROFILE_NAV];

export function visibleNav(items: readonly ShellNavItem[], showSocialNav: boolean): ShellNavItem[] {
  return items.filter((item) => showSocialNav || !item.socialGated);
}

/**
 * Which nav entry the current route belongs to. `profileSlug` is the
 * viewer's own profile segment (username, falling back to id) so that
 * someone else's profile does NOT light up "Profile" — it isn't your page.
 */
export function activeNavKey(pathname: string, profileSlug: string | null): ShellNavKey | null {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (under("/feed")) return "home";
  if (under("/discovery") || under("/community")) return "discovery";
  if (under("/notifications") || under("/activity")) return "notifications";
  if (under("/search")) return "search";
  if (under("/wallet")) return "wallet";
  if (pathname === "/profile" || under("/profile/edit") || (profileSlug && under(`/profile/${profileSlug}`))) return "profile";
  return null;
}
