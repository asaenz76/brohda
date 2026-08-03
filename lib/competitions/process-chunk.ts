import type { createAdminClient } from "@/lib/supabase/admin";
import { toFixtureRow, toTeamRows } from "@/lib/sports-data/persist";
import type { NormalizedFixture } from "@/lib/sports-data/types";

export interface ChunkToProcess {
  id: string;
  fixtures_payload: unknown;
}

export type ProcessChunkResult = { success: true } | { success: false; error: string };

/**
 * Persists one chunk's fixtures — shared by the synchronous "process the
 * first chunk immediately" step (startCompetitionImportAction) and the
 * cron's claimed-chunk processing loop, so the two never drift apart.
 * Bulk upserts (one call for all of a chunk's fixtures, one for all its
 * teams), not a per-fixture loop — the league row itself is upserted once
 * per import at job-start time, not repeated here, since every fixture in
 * a competition-import job shares the same league.
 */
export async function processImportChunk(
  adminClient: ReturnType<typeof createAdminClient>,
  chunk: ChunkToProcess,
): Promise<ProcessChunkResult> {
  const fixtures = chunk.fixtures_payload as NormalizedFixture[] | null;
  if (!fixtures || fixtures.length === 0) {
    return { success: false, error: "Chunk has no staged fixtures to process." };
  }

  const fixtureRows = fixtures.map(toFixtureRow);
  const { error: fixturesError } = await adminClient
    .from("fixtures")
    .upsert(fixtureRows, { onConflict: "provider,external_fixture_id" });
  if (fixturesError) {
    return { success: false, error: `Fixture upsert failed: ${fixturesError.message}` };
  }

  // Deduplicated by (provider, external_id) before upserting — any team
  // appearing in more than one fixture within this chunk (virtually
  // guaranteed across a real season, since every team plays repeatedly)
  // would otherwise produce two rows targeting the same conflict target
  // in a single INSERT, which Postgres rejects outright: "ON CONFLICT DO
  // UPDATE command cannot affect row a second time." Last write wins,
  // which is fine here — every fixture provides the same team name/logo.
  const teamRowsByKey = new Map<string, ReturnType<typeof toTeamRows>[number]>();
  for (const row of fixtures.flatMap(toTeamRows)) {
    teamRowsByKey.set(`${row.provider}:${row.external_id}`, row);
  }
  const teamRows = [...teamRowsByKey.values()];

  if (teamRows.length > 0) {
    const { error: teamsError } = await adminClient
      .from("teams")
      .upsert(teamRows, { onConflict: "provider,external_id" });
    if (teamsError) {
      return { success: false, error: `Team upsert failed: ${teamsError.message}` };
    }
  }

  return { success: true };
}
