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

// Configurable so a local run can avoid a port already held by something
// else on the machine; defaults to 3000, unchanged from before.
const e2ePort = process.env.E2E_PORT ?? "3000";
const e2eBaseUrl = `http://localhost:${e2ePort}`;

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
    baseURL: process.env.APP_URL ?? e2eBaseUrl,
    trace: "on-first-retry",
  },
  webServer: {
    command: process.env.E2E_PORT ? `pnpm dev --port ${e2ePort}` : "pnpm dev",
    url: e2eBaseUrl,
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
      API_NFL_ENABLED: "false",
      CRON_SECRET: "e2e-placeholder",
      RESEND_API_KEY: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
    },
  },
  // Two projects, not a global fullyParallel:false — every other spec
  // (paid-entry-flow, free-entry-flow, invite-flow, and any future one)
  // stays fully parallel-eligible in "chromium". Only
  // platform-capability-toggle-flow.spec.ts — the one file that mutates
  // the platform_settings singleton, a real cross-test shared resource,
  // the same class of problem vitest.integration.config.ts already solves
  // for the integration suite via fileParallelism:false — is pulled into
  // its own project. `dependencies: ["chromium"]` is Playwright's own
  // ordering primitive ("List of projects that need to run before any
  // test in this project runs" — @playwright/test's own type doc): it
  // guarantees zero time-overlap between the two projects, so the
  // canonical `playwright test` command is deterministic with no manual
  // --workers=1, no test ordering flags, and no sleeps. The toggle
  // project's own fullyParallel:false is belt-and-suspenders on top of
  // that file's existing test.describe.configure({ mode: "serial" }) —
  // its own two tests were already guaranteed to run in order; this
  // config change is what stops them from ever running *alongside*
  // paid-entry-flow/free-entry-flow, which is the actual race that was
  // observed. The stale-client toggle test itself is unchanged — this is
  // purely a scheduling fix, not a change to what it verifies.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /platform-capability-toggle/,
    },
    {
      name: "chromium-capability-toggle",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /platform-capability-toggle/,
      fullyParallel: false,
      dependencies: ["chromium"],
    },
  ],
});
