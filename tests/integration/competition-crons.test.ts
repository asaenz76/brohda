/**
 * Integration tests for the three competition-import background jobs
 * (lib/competitions/process-imports-cron.ts, discovery-sync.ts,
 * availability-cache.ts) — real local Postgres; the provider is mocked
 * with realistic canned data (its own real-world correctness was verified
 * live in Phase 2).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { NormalizedFixture, NormalizedLeague } from "@/lib/sports-data/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let mockIsEnabled = true;
let mockLeagueById: Record<string, NormalizedLeague | null> = {};
let mockSeasonFixturesByKey: Record<string, NormalizedFixture[]> = {};

const getLeagueByIdMock = vi.fn(async (id: string) => mockLeagueById[id] ?? null);
const getSeasonFixturesMock = vi.fn(async (id: string, season: string) => mockSeasonFixturesByKey[`${id}:${season}`] ?? []);

vi.mock("@/lib/sports-data/api-football-provider", () => ({
  apiFootballProvider: {
    isEnabled: () => mockIsEnabled,
    getLeagueById: (id: string) => getLeagueByIdMock(id),
    getSeasonFixtures: (id: string, season: string) => getSeasonFixturesMock(id, season),
  },
}));

const { runCompetitionImportProcessing } = await import("@/lib/competitions/process-imports-cron");
const { runCompetitionDiscoverySync } = await import("@/lib/competitions/discovery-sync");
const { refreshRecommendationAvailabilityCache } = await import("@/lib/competitions/availability-cache");

function fixture(externalFixtureId: string, scheduledStartUtc: string, overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    provider: "api_football",
    externalFixtureId,
    sport: "football",
    competitionExternalId: "555002",
    competitionName: "Cron Test Competition",
    competitionCountry: "Testland",
    competitionLogoUrl: null,
    season: "2026",
    round: "Round 1",
    homeTeamExternalId: "2001",
    homeTeamName: "Cron Home FC",
    homeTeamLogoUrl: null,
    awayTeamExternalId: "2002",
    awayTeamName: "Cron Away FC",
    awayTeamLogoUrl: null,
    venueName: null,
    venueCity: null,
    venueTimezone: null,
    scheduledStartUtc,
    providerTimezone: "UTC",
    providerStatusCode: "NS",
    providerStatusDescription: "Not Started",
    internalStatus: "NOT_STARTED",
    elapsedMinutes: null,
    homeScore: null,
    awayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    regulationHomeScore: null,
    regulationAwayScore: null,
    extraTimeHomeScore: null,
    extraTimeAwayScore: null,
    penaltyHomeScore: null,
    penaltyAwayScore: null,
    providerPayload: {},
    ...overrides,
  };
}

async function cleanupTestData() {
  const { data: lsis } = await admin.from("league_season_imports").select("id").in("external_league_id", ["555002", "39", "140"]);
  for (const lsi of lsis ?? []) {
    const { data: jobs } = await admin.from("competition_import_jobs").select("id").eq("league_season_import_id", lsi.id);
    for (const job of jobs ?? []) {
      await admin.from("competition_import_job_chunks").delete().eq("job_id", job.id);
    }
    await admin.from("competition_import_jobs").delete().eq("league_season_import_id", lsi.id);
  }
  await admin.from("league_season_imports").delete().in("external_league_id", ["555002", "39", "140"]);
  await admin.from("leagues").delete().in("external_id", ["555002", "140"]);
  await admin.from("fixtures").delete().in("competition_external_id", ["555002", "140"]);
  await admin.from("competition_availability_cache").delete().eq("provider", "api_football");
  await admin.from("provider_request_log").delete().eq("request_type", "test-quota-breaker");
}

describe.skipIf(!SERVICE_ROLE_KEY)("competition background jobs", () => {
  beforeAll(cleanupTestData);
  afterEach(async () => {
    mockIsEnabled = true;
    mockLeagueById = {};
    mockSeasonFixturesByKey = {};
    getLeagueByIdMock.mockClear();
    getSeasonFixturesMock.mockClear();
    await cleanupTestData();
  });
  afterAll(cleanupTestData);

  describe("runCompetitionImportProcessing", () => {
    it("claims and processes remaining chunks, finalizing the job and league_season_import as IMPORTED", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "555002", name: "Cron Test" }).select("id").single();
      const { data: lsi } = await admin
        .from("league_season_imports")
        .insert({ provider: "api_football", external_league_id: "555002", season: "2026", league_id: league!.id, import_status: "IMPORTING" })
        .select("id")
        .single();
      const { data: job } = await admin
        .from("competition_import_jobs")
        .insert({ league_season_import_id: lsi!.id, status: "PENDING", total_fixtures: 2, max_attempts: 5 })
        .select("id")
        .single();

      const future1 = new Date(Date.now() + 86400_000).toISOString();
      const future2 = new Date(Date.now() + 2 * 86400_000).toISOString();
      await admin.from("competition_import_job_chunks").insert([
        { job_id: job!.id, chunk_index: 0, fixtures_payload: [fixture("9101", future1)], fixture_count: 1, payload_bytes: 100 },
        { job_id: job!.id, chunk_index: 1, fixtures_payload: [fixture("9102", future2)], fixture_count: 1, payload_bytes: 100 },
      ]);

      const result = await runCompetitionImportProcessing();
      expect(result.chunksClaimed).toBeGreaterThanOrEqual(2);
      expect(result.chunksSucceeded).toBeGreaterThanOrEqual(2);
      expect(result.jobsFinalized).toBeGreaterThanOrEqual(1);

      const { data: finalJob } = await admin.from("competition_import_jobs").select("status").eq("id", job!.id).single();
      expect(finalJob?.status).toBe("SUCCEEDED");

      const { data: finalLsi } = await admin.from("league_season_imports").select("*").eq("id", lsi!.id).single();
      expect(finalLsi?.import_status).toBe("IMPORTED");
      expect(finalLsi?.fixture_count_imported).toBe(2);
      expect(finalLsi?.upcoming_fixture_count).toBe(2);

      const { data: f1 } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9101").maybeSingle();
      const { data: f2 } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9102").maybeSingle();
      expect(f1).not.toBeNull();
      expect(f2).not.toBeNull();
    });

    it("finalizes a job as FAILED and marks the league_season_import IMPORT_FAILED once a chunk exhausts its attempts", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "555002", name: "Cron Test" }).select("id").single();
      const { data: lsi } = await admin
        .from("league_season_imports")
        .insert({ provider: "api_football", external_league_id: "555002", season: "2026", league_id: league!.id, import_status: "IMPORTING" })
        .select("id")
        .single();
      const { data: job } = await admin
        .from("competition_import_jobs")
        .insert({ league_season_import_id: lsi!.id, status: "PENDING", total_fixtures: 1, max_attempts: 2 })
        .select("id")
        .single();

      // A chunk whose payload is malformed (fixtures_payload not an array
      // of real fixtures) will fail toFixtureRow's upsert — simulate by
      // giving it an empty payload, which processImportChunk rejects.
      await admin.from("competition_import_job_chunks").insert({
        job_id: job!.id,
        chunk_index: 0,
        fixtures_payload: [],
        fixture_count: 0,
        payload_bytes: 2,
        attempt_count: 1, // one attempt already used
      });

      await runCompetitionImportProcessing(); // attempt 2 of 2 — exhausts
      const { data: finalJob } = await admin.from("competition_import_jobs").select("status").eq("id", job!.id).single();
      expect(finalJob?.status).toBe("FAILED");

      const { data: finalLsi } = await admin.from("league_season_imports").select("import_status").eq("id", lsi!.id).single();
      expect(finalLsi?.import_status).toBe("IMPORT_FAILED");
    });

    // Regression coverage for a real production incident: a historical
    // backfill created several jobs whose chunks all genuinely succeeded
    // (processed by a different runCompetitionImportProcessing invocation
    // than the one that would normally notice — claim_import_job_chunks
    // claims across every in-flight job, not scoped to any one caller's
    // own job, so this cross-invocation finish is real, not hypothetical),
    // but neither the job's own `status` column nor its
    // league_season_imports row was ever updated — both stayed stuck
    // RUNNING/IMPORTING indefinitely, since finalization used to depend
    // entirely on "the same tick that claims the last chunk also
    // finalizes it." The reconciliation pass in process-imports-cron.ts
    // closes this gap.
    describe("reconciliation pass — finalizing jobs whose last chunk finished in a different invocation", () => {
      async function seedFinishedButUnfinalizedJob(status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
        const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "555002", name: "Cron Test" }).select("id").single();
        const { data: lsi } = await admin
          .from("league_season_imports")
          .insert({ provider: "api_football", external_league_id: "555002", season: "2026", league_id: league!.id, import_status: "IMPORTING" })
          .select("id")
          .single();
        // The job's own status column is deliberately left RUNNING here —
        // exactly the observed real state: recalculate_import_job_progress
        // (the only thing that updates it) was never called after the
        // chunk actually finished.
        const { data: job } = await admin
          .from("competition_import_jobs")
          .insert({ league_season_import_id: lsi!.id, status: "RUNNING", total_fixtures: 1, max_attempts: 5 })
          .select("id")
          .single();

        const future = new Date(Date.now() + 86400_000).toISOString();
        if (status === "SUCCEEDED") {
          // The chunk itself is already SUCCEEDED — as if a different
          // invocation processed it — and its fixture already exists, same
          // as processImportChunk would have written it (bypassing that
          // function here since this test is about finalization, not
          // chunk processing).
          await admin.from("competition_import_job_chunks").insert({
            job_id: job!.id,
            chunk_index: 0,
            fixtures_payload: [fixture("9103", future)],
            fixture_count: 1,
            payload_bytes: 100,
            status: "SUCCEEDED",
            processed_at: new Date().toISOString(),
          });
          await admin.from("fixtures").upsert(
            {
              provider: "api_football",
              external_fixture_id: "9103",
              sport: "football",
              competition_external_id: "555002",
              season: "2026",
              round: "Round 1",
              home_team_name: "Cron Home FC",
              away_team_name: "Cron Away FC",
              scheduled_start_utc: future,
              internal_status: "NOT_STARTED",
            },
            { onConflict: "provider,external_fixture_id" },
          );
        } else {
          await admin.from("competition_import_job_chunks").insert({
            job_id: job!.id,
            chunk_index: 0,
            fixtures_payload: [],
            fixture_count: 0,
            payload_bytes: 2,
            status: "FAILED",
            attempt_count: 5, // already exhausted
            last_error: "simulated permanent failure",
          });
        }
        return { lsi: lsi!.id, job: job!.id };
      }

      it("1+2+3+4: a multi-invocation-finished job (chunks terminal, job.status still stale RUNNING, league_season_imports still IMPORTING) is found and flipped to IMPORTED by the next reconciliation pass", async () => {
        const { lsi, job } = await seedFinishedButUnfinalizedJob("SUCCEEDED");

        // Precondition, proving this is genuinely the stuck state before
        // reconciliation runs — not already correct by some other path.
        const { data: preJob } = await admin.from("competition_import_jobs").select("status").eq("id", job).single();
        const { data: preLsi } = await admin.from("league_season_imports").select("import_status").eq("id", lsi).single();
        expect(preJob?.status).toBe("RUNNING");
        expect(preLsi?.import_status).toBe("IMPORTING");

        const result = await runCompetitionImportProcessing();
        expect(result.jobsReconciled).toBeGreaterThanOrEqual(1);

        const { data: postJob } = await admin.from("competition_import_jobs").select("status").eq("id", job).single();
        const { data: postLsi } = await admin.from("league_season_imports").select("*").eq("id", lsi).single();
        expect(postJob?.status).toBe("SUCCEEDED");
        expect(postLsi?.import_status).toBe("IMPORTED");
        expect(postLsi?.fixture_count_imported).toBe(1);
        expect(postLsi?.upcoming_fixture_count).toBe(1);
      });

      it("5: repeated finalization is idempotent — a second reconciliation pass over an already-IMPORTED row changes nothing and reconciles nothing further", async () => {
        const { lsi, job } = await seedFinishedButUnfinalizedJob("SUCCEEDED");
        await runCompetitionImportProcessing();

        const { data: afterFirst } = await admin.from("league_season_imports").select("*").eq("id", lsi).single();
        const secondResult = await runCompetitionImportProcessing();
        const { data: afterSecond } = await admin.from("league_season_imports").select("*").eq("id", lsi).single();

        expect(afterSecond?.import_status).toBe("IMPORTED");
        expect(afterSecond?.fixture_count_imported).toBe(afterFirst?.fixture_count_imported);
        expect(afterSecond?.upcoming_fixture_count).toBe(afterFirst?.upcoming_fixture_count);
        // Nothing left to reconcile the second time — the row is no
        // longer IMPORTING, so the pass never even considers this job.
        expect(secondResult.jobsReconciled).toBe(0);

        const { data: jobRow } = await admin.from("competition_import_jobs").select("status").eq("id", job).single();
        expect(jobRow?.status).toBe("SUCCEEDED");
      });

      it("reconciles a FAILED job the same way — league_season_imports flips to IMPORT_FAILED, not silently left IMPORTING", async () => {
        const { lsi } = await seedFinishedButUnfinalizedJob("FAILED");
        const result = await runCompetitionImportProcessing();
        expect(result.jobsReconciled).toBeGreaterThanOrEqual(1);

        const { data: postLsi } = await admin.from("league_season_imports").select("import_status").eq("id", lsi).single();
        expect(postLsi?.import_status).toBe("IMPORT_FAILED");
      });

      it("6: no provider calls occur during finalization/reconciliation — getSeasonFixtures/getLeagueById are never invoked", async () => {
        await seedFinishedButUnfinalizedJob("SUCCEEDED");
        await runCompetitionImportProcessing();

        expect(getSeasonFixturesMock).not.toHaveBeenCalled();
        expect(getLeagueByIdMock).not.toHaveBeenCalled();
      });
    });
  });

  describe("runCompetitionDiscoverySync", () => {
    // Discovery only ever operates on SUPPORTED_COMPETITIONS (see
    // lib/sports-data/supported-competitions.ts) — "140" is LaLiga, a real
    // supported id distinct from "39" (already used by the availability-
    // cache describe block below) so the two suites' mocked provider data
    // don't collide.
    it("adds a newly scheduled fixture and updates a rescheduled one, on a due (never-discovered) competition", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "140", name: "LaLiga" }).select("id").single();
      const originalStart = new Date(Date.now() + 5 * 86400_000).toISOString();
      await admin.from("fixtures").insert({
        provider: "api_football",
        external_fixture_id: "9201",
        competition_external_id: "140",
        season: "2026",
        home_team_name: "Cron Home FC",
        away_team_name: "Cron Away FC",
        scheduled_start_utc: originalStart,
        internal_status: "NOT_STARTED",
      });
      const { data: lsi } = await admin
        .from("league_season_imports")
        .insert({
          provider: "api_football",
          external_league_id: "140",
          season: "2026",
          league_id: league!.id,
          import_status: "IMPORTED",
          is_active: true,
          last_fixture_discovery_at: null,
        })
        .select("id")
        .single();

      const rescheduledStart = new Date(Date.now() + 8 * 86400_000).toISOString(); // postponed
      const newFixtureStart = new Date(Date.now() + 10 * 86400_000).toISOString();
      mockSeasonFixturesByKey["140:2026"] = [
        fixture("9201", rescheduledStart, { competitionExternalId: "140" }), // postponed relative to what's stored
        fixture("9202", newFixtureStart, { competitionExternalId: "140" }), // brand new
      ];

      const result = await runCompetitionDiscoverySync();
      expect(result.competitionsChecked).toBeGreaterThanOrEqual(1);
      expect(result.fixturesAdded).toBeGreaterThanOrEqual(1);
      expect(result.fixturesUpdated).toBeGreaterThanOrEqual(1);

      const { data: rescheduled } = await admin.from("fixtures").select("scheduled_start_utc").eq("external_fixture_id", "9201").single();
      expect(new Date(rescheduled!.scheduled_start_utc).getTime()).toBe(new Date(rescheduledStart).getTime());

      const { data: added } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9202").maybeSingle();
      expect(added).not.toBeNull();

      const { data: finalLsi } = await admin.from("league_season_imports").select("upcoming_fixture_count, last_fixture_discovery_at").eq("id", lsi!.id).single();
      expect(finalLsi?.upcoming_fixture_count).toBe(2);
      expect(finalLsi?.last_fixture_discovery_at).not.toBeNull();

      await admin.from("fixtures").delete().in("external_fixture_id", ["9201", "9202"]);
    });

    it("never collapses fixture_count_imported to the provider's row count when it's less than what's already stored (regression: two production competitions had 98 and 56 real imported fixtures silently zeroed out this way)", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "140", name: "LaLiga" }).select("id").single();
      const upcoming1 = new Date(Date.now() + 3 * 86400_000).toISOString();
      const upcoming2 = new Date(Date.now() + 5 * 86400_000).toISOString();
      const past = new Date(Date.now() - 3 * 86400_000).toISOString();
      await admin.from("fixtures").insert([
        { provider: "api_football", external_fixture_id: "9210", competition_external_id: "140", season: "2026", home_team_name: "A", away_team_name: "B", scheduled_start_utc: upcoming1, internal_status: "NOT_STARTED" },
        { provider: "api_football", external_fixture_id: "9211", competition_external_id: "140", season: "2026", home_team_name: "C", away_team_name: "D", scheduled_start_utc: upcoming2, internal_status: "NOT_STARTED" },
        { provider: "api_football", external_fixture_id: "9212", competition_external_id: "140", season: "2026", home_team_name: "E", away_team_name: "F", scheduled_start_utc: past, internal_status: "COMPLETED" },
      ]);
      const { data: lsi } = await admin
        .from("league_season_imports")
        .insert({
          provider: "api_football",
          external_league_id: "140",
          season: "2026",
          league_id: league!.id,
          import_status: "IMPORTED",
          is_active: true,
          fixture_count_imported: 3,
          upcoming_fixture_count: 2,
          last_fixture_discovery_at: null,
        })
        .select("id")
        .single();

      // Simulates the real incident: the provider call succeeds but
      // returns fewer rows than what's already correctly imported (a
      // partial response, or — before the soft-error fix elsewhere in
      // this codebase — a quota/rate-limit error that used to slip
      // through as an empty array).
      mockSeasonFixturesByKey["140:2026"] = [fixture("9210", upcoming1, { competitionExternalId: "140" })];

      await runCompetitionDiscoverySync();

      const { data: finalLsi } = await admin
        .from("league_season_imports")
        .select("fixture_count_imported, upcoming_fixture_count, provider_fixture_count")
        .eq("id", lsi!.id)
        .single();
      // The real, already-imported fixtures are untouched — counts must
      // reflect that, not the provider's smaller row count.
      expect(finalLsi?.fixture_count_imported).toBe(3);
      expect(finalLsi?.upcoming_fixture_count).toBe(2);
      // provider_fixture_count still reflects the provider's own
      // (smaller) count — otherwise the mismatch check it exists for
      // would be permanently tautological.
      expect(finalLsi?.provider_fixture_count).toBe(1);

      await admin.from("fixtures").delete().in("external_fixture_id", ["9210", "9211", "9212"]);
    });

    it("skips a competition whose discovery isn't due yet", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "140", name: "LaLiga" }).select("id").single();
      await admin
        .from("league_season_imports")
        .insert({
          provider: "api_football",
          external_league_id: "140",
          season: "2026",
          league_id: league!.id,
          import_status: "IMPORTED",
          is_active: true,
          last_fixture_discovery_at: new Date().toISOString(), // just discovered — not stale
        });

      mockSeasonFixturesByKey["140:2026"] = [fixture("9203", new Date(Date.now() + 86400_000).toISOString(), { competitionExternalId: "140" })];
      const result = await runCompetitionDiscoverySync();
      expect(result.competitionsChecked).toBe(0);

      const { data: notAdded } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9203").maybeSingle();
      expect(notAdded).toBeNull();
    });

    it("skips an imported-but-now-unsupported competition entirely (e.g. dropped from the curated list), without touching its data", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "555002", name: "Unsupported Test League" }).select("id").single();
      await admin.from("league_season_imports").insert({
        provider: "api_football",
        external_league_id: "555002", // not in SUPPORTED_COMPETITIONS
        season: "2026",
        league_id: league!.id,
        import_status: "IMPORTED",
        is_active: true,
        last_fixture_discovery_at: null,
      });

      mockSeasonFixturesByKey["555002:2026"] = [fixture("9204", new Date(Date.now() + 86400_000).toISOString())];
      const result = await runCompetitionDiscoverySync();
      expect(result.competitionsChecked).toBe(0);

      const { data: notAdded } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9204").maybeSingle();
      expect(notAdded).toBeNull();
    });

    it("skips the entire tick when the circuit breaker is open from a recent quota error, spending zero requests", async () => {
      const { data: league } = await admin.from("leagues").insert({ provider: "api_football", external_id: "140", name: "LaLiga" }).select("id").single();
      await admin.from("league_season_imports").insert({
        provider: "api_football",
        external_league_id: "140",
        season: "2026",
        league_id: league!.id,
        import_status: "IMPORTED",
        is_active: true,
        last_fixture_discovery_at: null,
      });
      await admin.from("provider_request_log").insert({
        provider: "api_football",
        request_type: "test-quota-breaker",
        error: "You have reached the request limit for the day",
        created_at: new Date().toISOString(),
      });

      mockSeasonFixturesByKey["140:2026"] = [fixture("9205", new Date(Date.now() + 86400_000).toISOString(), { competitionExternalId: "140" })];
      const result = await runCompetitionDiscoverySync();
      expect(result.competitionsChecked).toBe(0);

      const { data: notAdded } = await admin.from("fixtures").select("id").eq("external_fixture_id", "9205").maybeSingle();
      expect(notAdded).toBeNull();

      await admin.from("provider_request_log").delete().eq("request_type", "test-quota-breaker");
    });
  });

  describe("refreshRecommendationAvailabilityCache", () => {
    it("creates a cache row for a priority league with an upcoming fixture in the recommendation window", async () => {
      mockLeagueById["39"] = {
        provider: "api_football",
        externalLeagueId: "39",
        name: "Premier League",
        type: "League",
        countryName: "England",
        logoUrl: null,
        seasons: [{ year: "2026", startDate: "2026-08-01", endDate: "2027-05-01", current: true, coverage: null }],
      };
      mockSeasonFixturesByKey["39:2026"] = [fixture("9301", new Date(Date.now() + 5 * 86400_000).toISOString())];

      const result = await refreshRecommendationAvailabilityCache();
      expect(result.checked).toBeGreaterThan(0);
      expect(result.refreshed).toBeGreaterThan(0);

      const { data: cacheRow } = await admin
        .from("competition_availability_cache")
        .select("*")
        .eq("external_league_id", "39")
        .maybeSingle();
      expect(cacheRow?.upcoming_fixture_count).toBe(1);
      expect(cacheRow?.season).toBe("2026");
    });

    it("skips re-checking a league whose cache is still within its TTL", async () => {
      await admin.from("competition_availability_cache").insert({
        provider: "api_football",
        external_league_id: "39",
        season: "2026",
        upcoming_fixture_count: 1,
        checked_at: new Date().toISOString(), // fresh
        window_days: 30,
      });
      mockLeagueById["39"] = null; // if it were (incorrectly) re-checked, getLeagueById would return null and clobber the row

      await refreshRecommendationAvailabilityCache();

      const { data: cacheRow } = await admin
        .from("competition_availability_cache")
        .select("upcoming_fixture_count")
        .eq("external_league_id", "39")
        .single();
      expect(cacheRow?.upcoming_fixture_count).toBe(1); // untouched
    });
  });
});
