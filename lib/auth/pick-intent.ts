// Brohda 2.1 M7 — a visitor's intent to Pick a side, carried through sign-up or log-in as a plain, harmless hint on the Game's own URL ("/post/<id>?pick=YES"). It is only ever a HINT: nothing is recorded for a
// signed-out visitor, nothing is saved by following it, and after auth the Member still has to confirm explicitly (the Post shows "You chose X — Confirm your pick"). Anything that is not exactly YES or NO is
// ignored, so a hand-crafted link can neither pick for anyone nor reach a different page (the path itself goes through sanitizeNextPath, which refuses everything that is not a same-origin internal path).
import { sanitizeNextPath } from "./safe-next";

export type PickIntentOutcome = "YES" | "NO";

/** The outcome in `?pick=`, or null when it is missing or anything but exactly YES / NO (case-insensitive). */
export function parsePickIntent(raw: unknown): PickIntentOutcome | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return upper === "YES" || upper === "NO" ? upper : null;
}

// A Post id is a UUID in the database; the pattern accepts any plain id token (letters, digits, "-", "_") and nothing that could be a path, a query or a host.
const POST_ID = "[A-Za-z0-9_-]{1,64}";

/** "/post/<id>?pick=YES" (anything that is not a plain id token yields null) — the path a sign-up or log-in link returns the visitor to. */
export function postIntentPath(postId: string, outcome: PickIntentOutcome): string | null {
  if (!new RegExp(`^${POST_ID}$`).test(postId)) return null;
  return sanitizeNextPath(`/post/${postId}?pick=${outcome}`);
}

/** The Post id when `next` is "/post/<id>" (with or without a query), else null — so the auth screens can name the Game the visitor came for. */
export function postIdFromNext(next: unknown): string | null {
  const safe = sanitizeNextPath(next);
  if (!safe) return null;
  const match = new RegExp(`^/post/(${POST_ID})(?:[?#].*)?$`).exec(safe);
  return match ? match[1] : null;
}
