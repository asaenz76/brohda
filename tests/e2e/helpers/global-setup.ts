/**
 * Playwright globalSetup — defense-in-depth layer alongside the top-level
 * guard call in playwright.config.ts (the load-bearing one: it runs
 * synchronously the instant Playwright loads the config file, before this
 * globalSetup and before webServer are even scheduled, so a bad target
 * aborts before anything starts regardless of globalSetup/webServer
 * ordering). This re-validates and prints the resolved target so a run's
 * logs are self-proving — see docs/TESTING.md's E2E section.
 */
import { assertSafeTestSupabaseUrl, getTestAdminClient, getTestSupabaseConfig } from "./test-env";

export default async function globalSetup() {
  const { url } = getTestSupabaseConfig();
  assertSafeTestSupabaseUrl(url);
  console.log(`[e2e globalSetup] Verified E2E Supabase target: ${url}`);

  // Milestone R13.10 (Stage 0) — social_prediction_enabled defaults false
  // in production (deploy != activate), but almost every existing Brohda
  // 2.0 E2E spec (discovery-markets, predictions-flow, call-bs-challenges,
  // monetary-challenge-position, p2p-settlement, reputation-leaderboards,
  // post-conversation) navigates an ordinary (non-admin) test user
  // straight to /markets, /post/[id], etc. and asserts on the real page
  // content — none of them test this new access gate itself, so set it
  // once, globally, for the whole E2E run rather than touching every spec
  // file. platform-capability-toggle-flow.spec.ts and admin-brohda-
  // settings.spec.ts already manage their own platform_settings state
  // per-test and are unaffected by this ambient default.
  const admin = getTestAdminClient();
  const { error } = await admin.from("platform_settings").update({ social_prediction_enabled: true }).eq("id", true);
  if (error) throw error;
}
