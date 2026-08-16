/**
 * Regression coverage for Phase 4.1: getCompetitionManagerDataAction and
 * getCompetitionWorkspaceData used to destructure Supabase query results
 * as `{ data }`, discarding `error` entirely — a genuine DB failure
 * silently degraded to `data ?? []` / `data ?? null`, which the UI then
 * rendered identically to "there really are no competitions" or "this
 * competition doesn't exist." Both now distinguish the two cases
 * explicitly: a query failure returns/throws an observable error, never
 * an empty-looking success.
 *
 * Failure injection uses a thin fake query builder (chainable, thenable,
 * matching the real @supabase/supabase-js PostgrestFilterBuilder shape)
 * wrapping the real admin client — only the one table under test in a
 * given case is faked to fail; everything else goes to the real database,
 * so the "does the rest of the function still behave correctly" surface
 * stays a real integration test, not a fully mocked unit test.
 *
 * Run with: pnpm test:integration
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

let FAKE_ADMIN_ID: string;

vi.mock("@/lib/auth/session", () => ({
  requireAdminOrAbove: vi.fn(async () => ({ id: FAKE_ADMIN_ID, role: "super_admin" })),
}));

// A minimal, chainable, thenable fake matching PostgrestFilterBuilder's
// real shape closely enough for these two functions' exact call patterns
// (.select/.eq/.in/.order/.gte/.limit/.maybeSingle/.single, all
// chainable, `await`-able at any point).
function failingQuery(error: { message: string; code?: string }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    gte: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error }),
    single: () => Promise.resolve({ data: null, error }),
    then: (resolve: (v: { data: null; error: typeof error }) => void) => resolve({ data: null, error }),
  };
  return builder;
}

let failingTable: string | null = null;
let failingRpc: string | null = null;
const SIMULATED_ERROR = { message: "simulated Postgrest failure (Phase 4.1 test)", code: "TEST_FAILURE" };

function wrapWithFailure(realClient: typeof admin) {
  return {
    ...realClient,
    from(table: string) {
      if (table === failingTable) return failingQuery(SIMULATED_ERROR);
      return realClient.from(table);
    },
    rpc(name: string, args: unknown) {
      if (name === failingRpc) return Promise.resolve({ data: null, error: SIMULATED_ERROR });
      return (realClient.rpc as (n: string, a: unknown) => unknown)(name, args);
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => wrapWithFailure(admin),
}));

const { getCompetitionManagerDataAction } = await import("@/lib/actions/competitions");
const { getCompetitionWorkspaceData } = await import("@/lib/competitions/workspace-data");

describe.skipIf(!SERVICE_ROLE_KEY)("getCompetitionManagerDataAction — DB-error semantics (Phase 4.1)", () => {
  let seededLeagueId: string;
  let seededLsiId: string;

  beforeAll(async () => {
    const { data } = await admin.from("user_profiles").select("id").eq("role", "super_admin").eq("is_active", true).limit(1).single();
    FAKE_ADMIN_ID = data!.id as string;

    // getCompetitionManagerDataAction's "round 2" queries (leagues,
    // get_competition_fixture_aggregates) only run at all when at least
    // one league_season_imports row exists — this used to rely on
    // production always having real imported competitions, which doesn't
    // hold against an isolated, freshly-reset local database (Phase 4.1
    // test-isolation remediation). Seeded here instead, with an
    // external_league_id far outside any real provider ID range.
    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .insert({ provider: "api_football", external_id: "999999001", name: "Test League (competition-manager-error-semantics)" })
      .select("id")
      .single();
    if (leagueError || !league) throw leagueError ?? new Error("failed to seed test league");
    seededLeagueId = league.id as string;

    const { data: lsi, error: lsiError } = await admin
      .from("league_season_imports")
      .insert({
        provider: "api_football",
        external_league_id: "999999001",
        season: "2026",
        league_id: seededLeagueId,
        import_status: "IMPORTED",
      })
      .select("id")
      .single();
    if (lsiError || !lsi) throw lsiError ?? new Error("failed to seed test league_season_imports row");
    seededLsiId = lsi.id as string;
  });

  afterAll(async () => {
    if (seededLsiId) await admin.from("league_season_imports").delete().eq("id", seededLsiId);
    if (seededLeagueId) await admin.from("leagues").delete().eq("id", seededLeagueId);
  });

  it("succeeds with well-formed arrays when every query succeeds — the valid-empty/non-empty case is not itself a failure", async () => {
    failingTable = null;
    failingRpc = null;
    const result = await getCompetitionManagerDataAction();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Array.isArray(result.data.imported)).toBe(true);
    expect(Array.isArray(result.data.needsAttention)).toBe(true);
    expect(Array.isArray(result.data.allSupported)).toBe(true);
    // allSupported comes from the static config regardless of DB state,
    // so it's the one field guaranteed non-empty here.
    expect(result.data.allSupported.length).toBeGreaterThan(0);
  });

  it("a league_season_imports query failure returns a typed error, never an empty-looking success (round 1)", async () => {
    failingTable = "league_season_imports";
    failingRpc = null;
    const result = await getCompetitionManagerDataAction();
    failingTable = null;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Competition data could not be loaded.");
    // Must not be confusable with a real empty state — there is no
    // `.imported`/`.allSupported` to accidentally read as "no data" here,
    // the discriminated type itself makes that a compile error.
    expect("data" in result).toBe(false);
  });

  it("a competition_availability_cache query failure also fails the whole action (round 1, the other query)", async () => {
    failingTable = "competition_availability_cache";
    const result = await getCompetitionManagerDataAction();
    failingTable = null;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Competition data could not be loaded.");
  });

  it("a leagues query failure fails the whole action (round 2, derived from round 1's rows)", async () => {
    failingTable = "leagues";
    const result = await getCompetitionManagerDataAction();
    failingTable = null;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Competition data could not be loaded.");
  });

  it("a get_competition_fixture_aggregates RPC failure fails the whole action (round 2, the RPC)", async () => {
    failingRpc = "get_competition_fixture_aggregates";
    const result = await getCompetitionManagerDataAction();
    failingRpc = null;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Competition data could not be loaded.");
  });
});

describe.skipIf(!SERVICE_ROLE_KEY)("getCompetitionWorkspaceData — DB-error semantics (Phase 4.1)", () => {
  // Deliberately different fake ids per test, not just for clarity — this
  // function is wrapped in React's `cache()`, whose de-duplication is
  // meant to be scoped per-request; called directly in a test process
  // (no request boundary), it's safer to assume nothing about whether
  // that memoization resets between calls than to risk two tests silently
  // sharing one cached result for the same id.
  it("returns null for a genuinely nonexistent id — a real 404, distinct from a query failure", async () => {
    failingTable = null;
    const data = await getCompetitionWorkspaceData("00000000-0000-0000-0000-000000000001");
    expect(data).toBeNull();
  });

  it("throws (never returns null) when the league_season_imports lookup itself fails — a DB failure must not present as notFound()", async () => {
    failingTable = "league_season_imports";
    await expect(getCompetitionWorkspaceData("00000000-0000-0000-0000-000000000002")).rejects.toThrow("Competition workspace data could not be loaded.");
    failingTable = null;
  });
});
