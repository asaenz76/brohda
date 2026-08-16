/**
 * Vitest globalSetup for the integration suite — runs once, before any
 * test file is even imported. This is the earliest possible point to
 * refuse an unsafe run: if this throws, Vitest aborts before a single
 * `describe`/`it` executes, so a misconfigured target can never reach a
 * live database write.
 *
 * This duplicates the check every test file's client construction already
 * performs via tests/integration/helpers/test-env.ts — that's intentional
 * defense in depth (Phase 4.1 remediation), not redundancy to be trimmed:
 * a fast, loud, whole-suite failure here is strictly better than 45 files
 * each discovering the same misconfiguration on their own first query.
 */
import { assertSafeTestSupabaseUrl } from "./test-env";

export default function setup() {
  const url = process.env.TEST_SUPABASE_URL;
  if (!url) {
    console.error(
      "\nTEST_SUPABASE_URL is not set — refusing to run the integration suite.\n" +
        "There is no fallback to NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Run `pnpm supabase:start`, then `pnpm test:integration` (loads .env.test.local " +
        "— see .env.test.example).\n",
    );
    process.exit(1);
  }
  try {
    assertSafeTestSupabaseUrl(url);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
