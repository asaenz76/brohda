/**
 * Diagnostic/regression coverage for the real production bug: a
 * competition (Major League Soccer, in production) was shown as
 * "Season has ended" despite being a healthy, ongoing season with future
 * fixtures already imported. Root cause: getCompetitionManagerDataAction
 * used to fetch every raw fixture row across every imported competition
 * via an unordered `.in()` select with no pagination — PostgREST caps an
 * unordered select at its default row limit (1000), and production
 * already had 1852 fixtures across its 8 imported competitions at the
 * time this was diagnosed. Which ~1000 rows came back was effectively
 * arbitrary, so an entire competition's future fixtures could be dropped
 * from the aggregate while its past ones remained — making
 * allKnownFixturesAreTerminal wrongly true for that competition.
 *
 * This suite proves the fix: get_competition_fixture_aggregates computes
 * the aggregate entirely in SQL, so correctness never depends on how many
 * rows would have been transferred to the app. It seeds a single
 * competition with more fixtures than the old row cap, well past half of
 * them upcoming, and confirms the aggregate is still exactly right.
 *
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED", "ABANDONED", "AWARDED"];
const EXTERNAL_LEAGUE_ID = `fixture-agg-test-${randomUUID()}`;
const SEASON = "2026";

describe.skipIf(!SERVICE_ROLE_KEY)("get_competition_fixture_aggregates (RPC, row-cap regression)", () => {
  afterAll(async () => {
    await admin.from("fixtures").delete().eq("competition_external_id", EXTERNAL_LEAGUE_ID);
  });

  it("aggregates correctly across more than 1000 fixtures for one competition — the exact scale that silently truncated the old raw-row query", async () => {
    // 650 historical (COMPLETED) + 650 future (NOT_STARTED) = 1300 total,
    // comfortably past PostgREST's default 1000-row cap on its own.
    const now = Date.now();
    const historical = Array.from({ length: 650 }, (_, i) => ({
      external_fixture_id: `fixture-agg-hist-${randomUUID()}`,
      provider: "api_football",
      competition_external_id: EXTERNAL_LEAGUE_ID,
      season: SEASON,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(now - (i + 1) * 3600_000).toISOString(),
      internal_status: "COMPLETED",
    }));
    const future = Array.from({ length: 650 }, (_, i) => ({
      external_fixture_id: `fixture-agg-fut-${randomUUID()}`,
      provider: "api_football",
      competition_external_id: EXTERNAL_LEAGUE_ID,
      season: SEASON,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(now + (i + 1) * 3600_000).toISOString(),
      internal_status: "NOT_STARTED",
    }));

    const { error: insertError } = await admin.from("fixtures").insert([...historical, ...future]);
    expect(insertError).toBeNull();

    const { data, error } = await admin.rpc("get_competition_fixture_aggregates", {
      p_external_league_ids: [EXTERNAL_LEAGUE_ID],
      p_terminal_statuses: TERMINAL_STATUSES,
      p_activation_window_days: 14,
      p_recommendation_window_days: 30,
    });
    expect(error).toBeNull();

    const row = data!.find((r: { external_league_id: string }) => r.external_league_id === EXTERNAL_LEAGUE_ID);
    expect(row).toBeDefined();
    // The whole point: with 650 future NOT_STARTED fixtures actually
    // present, the aggregate must never report "all terminal" — the exact
    // false signal that produced the "Season has ended" misclassification.
    expect(row.all_known_fixtures_terminal).toBe(false);
    expect(row.has_fixture_within_activation_window).toBe(true);
    expect(row.next_fixture_at).not.toBeNull();

    // Confirms the scale actually exceeds what the old query silently
    // capped at — if this ever regresses to a lower fixture count, the
    // test above stops proving anything.
    const { count } = await admin
      .from("fixtures")
      .select("id", { count: "exact", head: true })
      .eq("competition_external_id", EXTERNAL_LEAGUE_ID);
    expect(count).toBeGreaterThan(1000);
  });
});
