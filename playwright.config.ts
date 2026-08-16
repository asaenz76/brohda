import { defineConfig, devices } from "@playwright/test";
import { getTestSupabaseConfig } from "./tests/e2e/helpers/test-env";

// Phase 4.2: this call is what makes an unsafe E2E target impossible, not
// just documented. It runs synchronously as soon as Playwright loads this
// config file — before webServer.command spawns `next dev`, before any
// spec file is read, before any network call. If TEST_SUPABASE_URL is
// missing or isn't the local Supabase CLI's fixed address, this throws
// and the whole `playwright test` invocation aborts right here.
//
// The root cause this closes: `next dev` (spawned below) does its own
// internal env-file loading via @next/env, and always includes
// `.env.local` — which holds real production Supabase credentials on a
// dev machine — for any var not already present in its process env.
// Empirically confirmed in this repo (Next 16.2.10): a value already set
// in process.env before `next dev` starts is NOT overridden by
// `.env.local`; only a var .env.local sets first can be. So the fix is to
// pre-populate exactly the vars the app reads (NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY) with these
// already-validated local values via webServer.env below — never let
// `.env.local` be the source nothing else already provided.
const testSupabase = getTestSupabaseConfig();

export default defineConfig({
  testDir: "./tests/e2e",
  // Defense-in-depth layer 2 (layer 1 is the top-level guard call above) —
  // see tests/e2e/helpers/global-setup.ts.
  globalSetup: "./tests/e2e/helpers/global-setup.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  // 30s default isn't enough for a spec's first navigation to a route
  // Turbopack hasn't compiled yet on a freshly-started dev server — every
  // CI run starts fresh, so this isn't a one-time local warmup cost.
  timeout: 60_000,
  // Web-first assertions (expect(page).toHaveURL(), etc.) have their own
  // separate default (5s), independent of the top-level `timeout` above —
  // a Server Action's dev-mode compile + redirect can take several seconds
  // longer than that on a cold Turbopack route.
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    // Deliberately NOT `!process.env.CI` (Playwright's usual local-dev
    // convenience default). Reusing an already-running server means
    // webServer.env below — the whole mechanism that keeps this process
    // off production — never gets applied: if a developer already has
    // `pnpm dev` running against real `.env.local` on port 3000 (a normal
    // thing to have open), E2E would silently test against THAT server,
    // production included. Always spawning a fresh, correctly-scoped
    // `next dev` costs a slower local run but is the only way the
    // guarantee in this file actually holds unconditionally.
    reuseExistingServer: false,
    timeout: 120_000,
    // Explicit projection, not a fallback: these are the SAME validated
    // TEST_SUPABASE_* values above, just under the var names the running
    // app actually reads (lib/supabase/admin.ts, next.config.ts's CSP
    // builder, the browser client). Provider flags are forced off here
    // too — .env.local has them enabled on at least one known dev
    // machine, which would otherwise make E2E capable of live provider
    // calls the same way it was capable of hitting production. The
    // remaining placeholders are the same ones CI used to set only for
    // itself — applied here for every E2E run (local or CI) so E2E never
    // uses real Resend/cron/Sentry credentials either, regardless of
    // what's ambient in .env.local.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: testSupabase.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: testSupabase.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: testSupabase.serviceRoleKey,
      API_FOOTBALL_ENABLED: "false",
      API_NFL_ENABLED: "false",
      CRON_SECRET: "e2e-placeholder",
      RESEND_API_KEY: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
