/**
 * Regression coverage for a real production incident: a provider
 * soft-error (quota exhausted, HTTP 200 with a populated `errors` body —
 * see api-football-provider.ts's parseApiFootballBody) thrown from
 * apiFootballProvider.searchLeagues("") inside getCompetitionManagerDataAction
 * took down the entire /admin/competitions page with an unhandled
 * ProviderApiError, since that call ran unconditionally during the page's
 * server-side render. Confirmed live via Sentry: "ProviderApiError GET
 * /admin/competitions".
 *
 * The fix isn't a try/catch around that call — it's that the call no
 * longer exists. getCompetitionManagerDataAction now builds "All
 * competitions" from the static SUPPORTED_COMPETITIONS config and the
 * database only, per the cache-first architecture. This test proves that
 * directly: the mocked provider throws on every method, and the action
 * must never call it at all.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let FAKE_ADMIN_ID: string;

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

function alwaysThrows(label: string) {
  return async () => {
    throw new Error(`${label} should never be called by getCompetitionManagerDataAction — page rendering must never spend provider quota.`);
  };
}

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    isEnabled: () => true,
    searchLeagues: alwaysThrows("searchLeagues"),
    getLeagueById: alwaysThrows("getLeagueById"),
    getSeasonFixtures: alwaysThrows("getSeasonFixtures"),
    searchFixtures: alwaysThrows("searchFixtures"),
    getFixtureById: alwaysThrows("getFixtureById"),
  },
}));

const { getCompetitionManagerDataAction } = await import("@/lib/actions/competitions");

describe.skipIf(!SERVICE_ROLE_KEY)("getCompetitionManagerDataAction — never calls the provider", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
  });

  it("renders the full page data set even with every provider method wired to throw", async () => {
    // If this call reached the provider at all, the test would throw
    // synchronously from inside alwaysThrows — reaching these assertions
    // at all is the proof.
    const data = await getCompetitionManagerDataAction();
    expect(Array.isArray(data.imported)).toBe(true);
    expect(Array.isArray(data.needsAttention)).toBe(true);
    expect(Array.isArray(data.allSupported)).toBe(true);
    // allSupported is built from the static config, so it's never empty
    // regardless of database state.
    expect(data.allSupported.length).toBeGreaterThan(0);
  });
});
