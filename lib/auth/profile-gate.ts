// Pure logic extracted from lib/supabase/middleware.ts so it's unit-
// testable without a real Supabase/Next.js request. A signed-in user
// without a username must finish onboarding before anything else — the
// only exempt path is /profile itself, where they'd actually fix it
// (everything else, including /admin, is fair game: staff accounts are
// subject to the same requirement, and there's no lockout risk since
// /profile never requires the admin role).
const PROFILE_GATE_EXEMPT_PREFIXES = ["/profile"];

export function needsProfileCompletionRedirect(
  pathname: string,
  username: string | null,
): boolean {
  if (username) return false;
  return !PROFILE_GATE_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
