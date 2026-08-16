/**
 * Integration tests for the nfl_game_results table's safety guarantees —
 * the authoritative confirmed-result gate NFL grading reads instead of the
 * raw, live-syncing fixtures.regulation_*_score (see lib/pools/templates/
 * nfl-confirmed-result.ts). These exercise the DB-level invariants the
 * migration enforces directly (insert/update/delete against the table),
 * the same operations lib/sports-data/sync-nfl.ts's reconciliation pass
 * performs — not the live API-NFL network call itself, matching every
 * other integration test in this repo (real DB, synthetic fixture data).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

const createdFixtureIds: string[] = [];

async function createTestNflFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: "api_nfl",
      external_fixture_id: `nfl-results-test-${randomUUID()}`,
      home_team_name: "Home Test",
      away_team_name: "Away Test",
      home_team_external_id: "10",
      away_team_external_id: "20",
      scheduled_start_utc: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      internal_status: "COMPLETED",
      regulation_home_score: 24,
      regulation_away_score: 21,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test NFL fixture");
  createdFixtureIds.push(data.id as string);
  return data.id as string;
}

describe.skipIf(!SERVICE_ROLE_KEY)("nfl_game_results — append-only confirmed result", () => {
  // nfl_game_results rows are permanent by design (no delete grant, no FK
  // from this table's own rows) — this test's rows are deliberately left
  // in place rather than cleaned up, exactly like production. Only the
  // synthetic fixtures get removed; nfl_game_results has no FK on
  // fixture_id (mirrors pool_grading_evidence), so that's never blocked.
  afterAll(async () => {
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
  });

  it("first confirmation creates one CONFIRMED, is_current row", async () => {
    const fixtureId = await createTestNflFixture();

    const { data: row, error } = await admin
      .from("nfl_game_results")
      .insert({
        fixture_id: fixtureId,
        home_team_external_id: "10",
        away_team_external_id: "20",
        home_final_score: 24,
        away_final_score: 21,
        status: "CONFIRMED",
        is_current: true,
      })
      .select("id, status, is_current")
      .single();

    expect(error).toBeNull();
    expect(row?.status).toBe("CONFIRMED");
    expect(row?.is_current).toBe(true);
  });

  it("a correction flips the old row to is_current=false (scores unchanged) and inserts a new CORRECTED, is_current=true row — full history preserved", async () => {
    const fixtureId = await createTestNflFixture();
    const { data: original } = await admin
      .from("nfl_game_results")
      .insert({
        fixture_id: fixtureId,
        home_final_score: 24,
        away_final_score: 21,
        status: "CONFIRMED",
        is_current: true,
      })
      .select("id")
      .single();

    const { error: flipError } = await admin
      .from("nfl_game_results")
      .update({ is_current: false })
      .eq("id", original!.id);
    expect(flipError).toBeNull();

    const { data: corrected, error: insertError } = await admin
      .from("nfl_game_results")
      .insert({
        fixture_id: fixtureId,
        home_final_score: 27,
        away_final_score: 21,
        status: "CORRECTED",
        is_current: true,
      })
      .select("id, status, is_current, home_final_score")
      .single();
    expect(insertError).toBeNull();
    expect(corrected?.status).toBe("CORRECTED");
    expect(corrected?.home_final_score).toBe(27);

    // Both rows still exist — nothing was overwritten, only the flag flipped.
    const { data: allRows } = await admin
      .from("nfl_game_results")
      .select("id, is_current, home_final_score, status")
      .eq("fixture_id", fixtureId)
      .order("created_at");
    expect(allRows).toHaveLength(2);
    expect(allRows![0]).toMatchObject({ id: original!.id, is_current: false, home_final_score: 24, status: "CONFIRMED" });
    expect(allRows![1]).toMatchObject({ id: corrected!.id, is_current: true, home_final_score: 27, status: "CORRECTED" });
  });

  it("rejects a direct score UPDATE on an existing row — the only permitted mutation is the is_current true->false flip", async () => {
    const fixtureId = await createTestNflFixture();
    const { data: row } = await admin
      .from("nfl_game_results")
      .insert({ fixture_id: fixtureId, home_final_score: 24, away_final_score: 21, status: "CONFIRMED", is_current: true })
      .select("id")
      .single();

    const { error } = await admin
      .from("nfl_game_results")
      .update({ home_final_score: 99 })
      .eq("id", row!.id);
    expect(error).not.toBeNull();
    expect(error?.message).toContain("append-only");
  });

  it("rejects flipping is_current from false back to true", async () => {
    const fixtureId = await createTestNflFixture();
    const { data: row } = await admin
      .from("nfl_game_results")
      .insert({ fixture_id: fixtureId, home_final_score: 24, away_final_score: 21, status: "CONFIRMED", is_current: true })
      .select("id")
      .single();
    await admin.from("nfl_game_results").update({ is_current: false }).eq("id", row!.id);

    const { error } = await admin.from("nfl_game_results").update({ is_current: true }).eq("id", row!.id);
    expect(error).not.toBeNull();
    expect(error?.message).toContain("append-only");
  });

  it("rejects a DELETE unconditionally — blocked at the grant level (service_role was never given delete), the no-delete trigger is defense-in-depth behind it", async () => {
    const fixtureId = await createTestNflFixture();
    const { data: row } = await admin
      .from("nfl_game_results")
      .insert({ fixture_id: fixtureId, home_final_score: 24, away_final_score: 21, status: "CONFIRMED", is_current: true })
      .select("id")
      .single();

    const { error } = await admin.from("nfl_game_results").delete().eq("id", row!.id);
    expect(error).not.toBeNull();
    expect(error?.message).toContain("permission denied");
  });

  it("rejects a second is_current=true row for the same fixture — exactly one authoritative result at a time", async () => {
    const fixtureId = await createTestNflFixture();
    await admin
      .from("nfl_game_results")
      .insert({ fixture_id: fixtureId, home_final_score: 24, away_final_score: 21, status: "CONFIRMED", is_current: true });

    const { error } = await admin
      .from("nfl_game_results")
      .insert({ fixture_id: fixtureId, home_final_score: 27, away_final_score: 21, status: "CORRECTED", is_current: true });
    expect(error).not.toBeNull();
  });
});
