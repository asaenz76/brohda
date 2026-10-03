/**
 * The human-readable message of anything that was thrown or returned as an
 * error. Supabase/PostgREST errors are plain objects, not Error instances
 * (`instanceof Error` is false and `String(error)` is the useless
 * "[object Object]"), but they carry the real text — an RPC's own
 * `raise exception 'not_recipient'` arrives as `.message === "not_recipient"`.
 * Everything that maps an RPC error to copy, or records one in a job
 * summary, must go through this, or the specific message is silently lost.
 *
 * (lib/sports-data/provider-errors.ts has an equivalent, extractErrorMessage, scoped to
 * provider code; this one is the shared entry point for everything else.)
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
}
