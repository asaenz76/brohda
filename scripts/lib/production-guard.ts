/**
 * Phase 3 spec §25 — a real incident this session: `pnpm create-super-admin`
 * was run intending to target a separate dev Supabase project, but the npm
 * script hardcodes `dotenv -e .env.local`, which — in this deployment —
 * points at production. The script itself had no way to know, so it
 * silently created a real auth account in production. This is the guard
 * that closes that gap for every write-capable script, checked BEFORE any
 * write.
 *
 * Deliberately outside `lib/` — nothing in the Next.js app itself needs
 * this, and it isn't `"server-only"`-gated since these scripts run under
 * plain `tsx`, outside Next's react-server bundler condition (see
 * create-super-admin.ts's own comment on why it can't import
 * lib/supabase/admin.ts).
 */
const LOCAL_SUPABASE_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export type SupabaseTarget = "local" | "remote";

export function resolveSupabaseTarget(url: string): SupabaseTarget {
  return LOCAL_SUPABASE_PATTERN.test(url) ? "local" : "remote";
}

/**
 * Refuses to continue when the resolved Supabase URL isn't a local
 * instance, unless the admin explicitly confirms intent — `--production`
 * on the command line, or `CONFIRM_PRODUCTION_WRITE=1` in the environment
 * for non-interactive use. Treats ANY non-local target the same way
 * (not just a hardcoded production project ref) — deliberately the more
 * conservative check, since a script pointed at some other real remote
 * project by mistake is exactly as unwanted as one pointed at production.
 */
export function assertProductionWriteConfirmed(url: string, scriptName: string): void {
  if (resolveSupabaseTarget(url) === "local") return;

  const confirmed = process.argv.includes("--production") || process.env.CONFIRM_PRODUCTION_WRITE === "1";
  if (confirmed) return;

  console.error(
    `Refusing to run ${scriptName}: this would write to a non-local Supabase project.\n` +
      `Resolved URL: ${url}\n` +
      "If this is genuinely intentional, confirm explicitly:\n" +
      `  pnpm ${scriptName} ... --production\n` +
      "or set CONFIRM_PRODUCTION_WRITE=1 for non-interactive use.",
  );
  process.exit(1);
}
