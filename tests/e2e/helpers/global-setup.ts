/**
 * Playwright globalSetup — defense-in-depth layer alongside the top-level
 * guard call in playwright.config.ts (the load-bearing one: it runs
 * synchronously the instant Playwright loads the config file, before this
 * globalSetup and before webServer are even scheduled, so a bad target
 * aborts before anything starts regardless of globalSetup/webServer
 * ordering). This re-validates and prints the resolved target so a run's
 * logs are self-proving — see docs/TESTING.md's E2E section.
 */
import { assertSafeTestSupabaseUrl, getTestSupabaseConfig } from "./test-env";

export default function globalSetup() {
  const { url } = getTestSupabaseConfig();
  assertSafeTestSupabaseUrl(url);
  console.log(`[e2e globalSetup] Verified E2E Supabase target: ${url}`);
}
