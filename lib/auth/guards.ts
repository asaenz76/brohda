import type { UserProfile } from "./session";

export function isUsableSession(profile: UserProfile | null): profile is UserProfile {
  return profile !== null && profile.is_active;
}

export function isSuperAdmin(profile: UserProfile): boolean {
  return profile.role === "super_admin";
}

// 'admin' is a distinct, lower-privileged role — full admin-panel access
// minus money movement (wallet/settlement/reversal) and account/role
// management, which stay gated by isSuperAdmin() specifically. Never
// conflate the two: this helper is for "can see the admin panel", not
// "can do anything a super_admin can".
export function isAdminOrAbove(profile: UserProfile): boolean {
  return profile.role === "super_admin" || profile.role === "admin";
}
