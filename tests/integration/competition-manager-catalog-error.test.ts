/**
 * Regression test for a real production incident: a provider soft-error
 * (quota exhausted, HTTP 200 with a populated `errors` body — see
 * api-football-provider.ts's parseApiFootballBody) thrown from
 * apiFootballProvider.searchLeagues("") inside
 * getCompetitionManagerDataAction took down the entire /admin/competitions
 * page with an unhandled ProviderApiError, since that call runs
 * unconditionally during the page's server-side render with no try/catch.
 * Confirmed live via Sentry: "ProviderApiError GET /admin/competitions".
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

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    isEnabled: () => true,
    searchLeagues: async () => {
      throw new Error("API-Football request failed: You have reached the request limit for the day, Go to https://dashboard.api-football.com to upgrade your plan.");
    },
  },
}));

const { getCompetitionManagerDataAction } = await import("@/lib/actions/competitions");

describe.skipIf(!SERVICE_ROLE_KEY)("getCompetitionManagerDataAction — catalog provider failure", () => {
  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;
  });

  it("never throws when the provider catalog call fails — returns a catalogError instead of crashing the page", async () => {
    const data = await getCompetitionManagerDataAction();
    expect(data.catalogError).toMatch(/request limit/);
    // The rest of the page's data still comes back — the catalog failure
    // degrades only the parts that depend on it.
    expect(Array.isArray(data.imported)).toBe(true);
    expect(Array.isArray(data.needsAttention)).toBe(true);
    expect(Array.isArray(data.allByCountry)).toBe(true);
    expect(data.allByCountry).toHaveLength(0); // no catalog available to group by country
  });
});
