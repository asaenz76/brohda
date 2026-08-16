/**
 * Single choke point every integration test's Supabase client must go
 * through. Phase 4.1 remediation: this codebase had integration tests
 * reading the SAME generic `NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_
 * ROLE_KEY` env vars that production code reads, loaded via
 * `dotenv -e .env.local` — on any machine where `.env.local` points at
 * production (as it did on the machine this was fixed on), the test
 * suite silently mutated production. It deleted real Premier League/
 * LaLiga fixture data and leaked pools/fixtures/notifications into
 * production continuously for weeks.
 *
 * The fix has two independent layers, both enforced here:
 *
 * 1. A completely separate env var namespace — TEST_SUPABASE_URL/
 *    TEST_SUPABASE_ANON_KEY/TEST_SUPABASE_SERVICE_ROLE_KEY — that nothing
 *    else in this codebase reads. There is deliberately NO fallback to
 *    NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY anywhere below: a
 *    missing TEST_SUPABASE_* var must fail loudly, never silently resolve
 *    to whatever production config happens to be sitting in the
 *    ambient environment.
 * 2. A hard allowlist on the resolved URL — it must match the fixed,
 *    publicly-documented local Supabase CLI address. Anything else
 *    (production, staging, an unrecognized remote project) throws before
 *    any client is constructed, before any test can run.
 *
 * Every integration test file must import its Supabase client(s) from
 * here (getTestAdminClient/getTestAnonClient), not construct its own via
 * `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, ...)`.
 */
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";

// The Supabase CLI's local stack always listens here — same fixed address
// on every machine and in CI (see .github/workflows/ci.yml). Intentionally
// the ONLY address this guard accepts; there is no "trusted remote test
// project" allowlist, matching the requirement that integration tests
// never target anything but a disposable local instance.
const ALLOWED_TEST_SUPABASE_URL_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost):54321\/?$/;

export class UnsafeTestSupabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTestSupabaseTargetError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new UnsafeTestSupabaseTargetError(
      `${name} is not set.\n` +
        "Integration tests require the TEST_SUPABASE_* environment variables — " +
        "there is no fallback to NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY " +
        "(those are production config; falling back to them is exactly how this " +
        "test suite deleted real production data before).\n" +
        "Run `pnpm supabase:start`, then `pnpm test:integration` (which loads " +
        ".env.test.local — see .env.test.example for the required values).",
    );
  }
  return value;
}

/**
 * Throws UnsafeTestSupabaseTargetError if `url` isn't the local Supabase
 * CLI's fixed address. Exported separately from the env lookups so the
 * production-guard proof (Part L) can call this directly against an
 * arbitrary URL — including a real production URL — without needing any
 * env vars set and without constructing a client.
 */
export function assertSafeTestSupabaseUrl(url: string): void {
  if (!ALLOWED_TEST_SUPABASE_URL_PATTERN.test(url)) {
    throw new UnsafeTestSupabaseTargetError(
      `Refusing to run integration tests against "${url}" — this is not the local ` +
        "Supabase CLI's address. Integration tests may ONLY target a local Supabase " +
        "instance (http://127.0.0.1:54321 or http://localhost:54321).\n" +
        "This guard exists because this exact class of mistake previously ran the " +
        "test suite against production and deleted real data.",
    );
  }
}

let cachedAdminClient: SupabaseClient | null = null;
let cachedAnonConfig: { url: string; anonKey: string } | null = null;
let appEnvVarsProjected = false;

/**
 * Test files aren't the only code that talks to Supabase during a test
 * run — real application code exercised by these tests (e.g.
 * lib/pools/templates/grade.ts's gradeTemplatePool, lib/notifications/
 * create.ts) calls lib/supabase/admin.ts's createAdminClient(), which
 * reads the plain NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * production var names directly — it has no idea it's running under a
 * test. For that code to also land on the safe local instance (instead of
 * either crashing with no client at all, or worse, resolving to whatever
 * happens to be in the ambient environment), those plain vars are set
 * here, DERIVED from the already-validated TEST_SUPABASE_* values passed
 * in — never independently read from the environment. This is not a
 * fallback (nothing here reads NEXT_PUBLIC_SUPABASE_URL as an input):
 * it's a one-way, validated-value-only projection, so there's no path for
 * an unvalidated production URL to reach these vars.
 *
 * Deliberately NOT run as a module-load-time side effect — this module is
 * also imported by tests/unit/test-env-guard.test.ts to unit-test
 * assertSafeTestSupabaseUrl in isolation, which has no TEST_SUPABASE_*
 * vars set at all (it runs under `pnpm test`, not `pnpm test:integration`)
 * and must not be forced through this projection just by importing the
 * module. Called instead from inside getTestSupabaseConfig(), so it only
 * ever fires for callers that actually resolve a real config.
 */
function projectValidatedConfigOntoAppEnvVars(config: { url: string; anonKey: string; serviceRoleKey: string }): void {
  if (appEnvVarsProjected) return;
  process.env.NEXT_PUBLIC_SUPABASE_URL = config.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = config.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceRoleKey;
  appEnvVarsProjected = true;
}

/** Validated, resolved test Supabase config — throws if unsafe or unset. */
export function getTestSupabaseConfig(): { url: string; anonKey: string; serviceRoleKey: string } {
  const url = requireEnv("TEST_SUPABASE_URL");
  assertSafeTestSupabaseUrl(url);
  const anonKey = requireEnv("TEST_SUPABASE_ANON_KEY");
  const serviceRoleKey = requireEnv("TEST_SUPABASE_SERVICE_ROLE_KEY");
  const config = { url, anonKey, serviceRoleKey };
  projectValidatedConfigOntoAppEnvVars(config);
  return config;
}

/** Service-role client for the isolated local test database. Memoized. */
export function getTestAdminClient(): SupabaseClient {
  if (!cachedAdminClient) {
    const { url, serviceRoleKey } = getTestSupabaseConfig();
    cachedAdminClient = createSupabaseClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedAdminClient;
}

/**
 * A fresh anon-key client for the isolated local test database — RLS/auth
 * tests sign in as different fake users, so this is intentionally NOT
 * memoized the way the admin client is (each caller needs its own,
 * independently-authenticatable client instance).
 */
export function getTestAnonClient(): SupabaseClient {
  if (!cachedAnonConfig) {
    const { url, anonKey } = getTestSupabaseConfig();
    cachedAnonConfig = { url, anonKey };
  }
  return createSupabaseClient(cachedAnonConfig.url, cachedAnonConfig.anonKey);
}
