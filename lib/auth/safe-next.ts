// Post-login return, without an open redirect. `?next=` may only ever carry a same-origin, relative, internal path; anything else —
// an absolute URL, a protocol-relative `//host`, a `javascript:` / `data:` URL, a backslash trick, control characters, an auth page that
// would loop — is rejected and the caller falls back (to /feed after login). One implementation, used both when a redirect to /login is
// BUILT (so a bad path never makes it into the URL) and when a login is FOLLOWED (so a hand-crafted link can't send anyone elsewhere).
// Pure and runtime-agnostic (no server-only imports): the login page, the server actions, the proxy and requireUser all share it.

const MAX_LENGTH = 2048;
// Control characters (incl. tab / CR / LF, which browsers strip inside URLs) and DEL.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Pages that would send a freshly logged-in person straight back to an auth screen.
const AUTH_PAGES = ["/login", "/register", "/logout", "/reset-password", "/invite", "/sponsor/login", "/sponsor/signup", "/sponsor/verified"];
const PARSE_BASE = "http://brohda.invalid";

/** The internal path to return to, or null when `raw` is missing or unsafe. Keeps the query string, drops any fragment. */
export function sanitizeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (CONTROL_CHARS.test(raw)) return null;
  // Must be a single-slash relative path: not absolute ("https:", "javascript:", "data:"), not protocol-relative ("//"), no backslashes
  // (browsers treat "\" like "/", so "/\evil.com" is "//evil.com").
  if (raw[0] !== "/" || raw[1] === "/" || raw.includes("\\")) return null;

  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  // Belt and braces: whatever the parser made of it must still be this origin.
  if (url.origin !== PARSE_BASE) return null;
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return null;

  const path = url.pathname;
  if (AUTH_PAGES.some((page) => path === page || path.startsWith(`${page}/`))) return null;

  return `${path}${url.search}`;
}

/** "/login" or "/login?next=<encoded path>" — a bad or missing path just yields the plain login URL. */
export function loginHrefFor(path: unknown): string {
  const safe = sanitizeNextPath(path);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

/** "/register" or "/register?next=<encoded path>" — for a sign-up prompt on a page that should bring the person back after sign-up. */
export function registerHrefFor(path: unknown): string {
  const safe = sanitizeNextPath(path);
  return safe ? `/register?next=${encodeURIComponent(safe)}` : "/register";
}

/** The request path header the proxy sets for server components (always overwritten there; never trusted from a client). */
export const REQUEST_PATH_HEADER = "x-brohda-request-path";
