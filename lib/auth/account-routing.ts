// Which part of the product an account may be in. Pure and runtime-agnostic (no server-only imports) so the proxy, the guards and the tests share ONE
// definition. A Brohda login is a MEMBER or a SPONSOR, never both; this is where each is kept out of the other's area. (The database enforces the same
// split on data; this is the navigation half of it.)
export type AccountType = "MEMBER" | "SPONSOR";

export const SPONSOR_HOME = "/sponsor";
export const MEMBER_HOME = "/feed";
export const SPONSOR_LOGIN = "/sponsor/login";
/** Pages a signed-out person can open inside the Sponsor area. */
export const SPONSOR_PUBLIC_PATHS = ["/sponsor/login", "/sponsor/signup", "/sponsor/verified"] as const;

// Every first path segment that belongs to the Member product (including the staff panel, which is Member-side). A Sponsor is redirected out of all of them.
const MEMBER_AREA = ["feed", "my-picks", "activity", "profile", "admin", "community", "discovery", "markets", "notifications", "post", "search", "wallet", "accept-terms"] as const;

function firstSegment(path: string): string {
  return path.split("?")[0].split("/")[1] ?? "";
}

/** True for /sponsor and everything under it — but NOT for /sponsorship/click/… (a different, public route that merely shares a prefix). */
export function isSponsorArea(path: string): boolean {
  return firstSegment(path) === "sponsor";
}

export function isSponsorPublicPath(path: string): boolean {
  const clean = path.split("?")[0].replace(/\/+$/, "");
  return SPONSOR_PUBLIC_PATHS.some((p) => clean === p);
}

export function isMemberArea(path: string): boolean {
  return (MEMBER_AREA as readonly string[]).includes(firstSegment(path));
}

/** "/sponsor/login" or "/sponsor/login?next=<encoded path>". The caller passes an already sanitised internal path (or nothing). */
export function sponsorLoginHrefFor(safeNext: string | null): string {
  return safeNext ? `${SPONSOR_LOGIN}?next=${encodeURIComponent(safeNext)}` : SPONSOR_LOGIN;
}

/**
 * Where a request must be sent instead of being served, or null to serve it. `accountType` is null for a signed-in login that has no type at all (an
 * unclassified legacy account) — it is treated as neither a Member nor a Sponsor and gets no Sponsor area.
 */
export function accountRedirect(input: { path: string; signedIn: boolean; accountType: AccountType | null; safeNext: string | null }): string | null {
  const { path, signedIn, accountType, safeNext } = input;
  if (isSponsorArea(path) && !isSponsorPublicPath(path)) {
    if (!signedIn) return sponsorLoginHrefFor(safeNext);
    if (accountType === "MEMBER") return MEMBER_HOME;
    if (accountType === null) return SPONSOR_LOGIN;
    return null;
  }
  if (signedIn && accountType === "SPONSOR" && isMemberArea(path)) return SPONSOR_HOME;
  return null;
}

/** Where an account lands right after signing in. */
export function homePathFor(accountType: AccountType | null): string {
  return accountType === "SPONSOR" ? SPONSOR_HOME : MEMBER_HOME;
}
