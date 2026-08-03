import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { processImportChunk } from "./process-chunk";
import { CHUNK_PAYLOAD_RECOVERY_WINDOW, IMPORT_CHUNKS_PER_CRON_TICK, IMPORT_JOB_MAX_ATTEMPTS } from "./constants";

export interface ProcessImportsResult {
  chunksClaimed: number;
  chunksSucceeded: number;
  chunksFailed: number;
  jobsFinalized: number;
  chunkPayloadsCleaned: number;
}

/**
 * One tick of the competition-import background processor — claims a
 * bounded batch of processable chunks (across every in-flight job, via
 * claim_import_job_chunks' FOR UPDATE SKIP LOCKED), persists each one,
 * recalculates every affected job's progress from chunk state, and
 * finalizes league_season_imports for any job that just reached a
 * terminal status. Also reclaims old succeeded-chunk payloads. Safe to
 * run concurrently with itself (claiming is what makes that safe) and
 * safe to re-run after a partial failure (every write here is either
 * idempotent or driven by recalculation, never a blind increment).
 */
export async function runCompetitionImportProcessing(): Promise<ProcessImportsResult> {
  const adminClient = createAdminClient();
  const result: ProcessImportsResult = {
    chunksClaimed: 0,
    chunksSucceeded: 0,
    chunksFailed: 0,
    jobsFinalized: 0,
    chunkPayloadsCleaned: 0,
  };

  const { data: claimed, error: claimError } = await adminClient.rpc("claim_import_job_chunks", {
    p_limit: IMPORT_CHUNKS_PER_CRON_TICK,
    p_max_attempts: IMPORT_JOB_MAX_ATTEMPTS,
  });
  if (claimError) throw new Error(`Failed to claim import chunks: ${claimError.message}`);

  result.chunksClaimed = claimed?.length ?? 0;
  const affectedJobIds = new Set<string>();

  for (const chunk of claimed ?? []) {
    affectedJobIds.add(chunk.job_id);
    const outcome = await processImportChunk(adminClient, chunk);
    await adminClient
      .from("competition_import_job_chunks")
      .update(
        outcome.success
          ? { status: "SUCCEEDED", processed_at: new Date().toISOString() }
          : { status: "FAILED", last_error: outcome.error },
      )
      .eq("id", chunk.id);
    if (outcome.success) result.chunksSucceeded += 1;
    else result.chunksFailed += 1;
  }

  for (const jobId of affectedJobIds) {
    const { data: job } = await adminClient
      .from("competition_import_jobs")
      .select("id, status, max_attempts, league_season_import_id, total_fixtures, include_historical")
      .eq("id", jobId)
      .single();
    if (!job) continue;

    const { data: recalculated } = await adminClient.rpc("recalculate_import_job_progress", {
      p_job_id: jobId,
      p_max_attempts: job.max_attempts,
    });
    if (!recalculated) continue;

    if (recalculated.status === "SUCCEEDED") {
      result.jobsFinalized += 1;
      const { count: upcomingCount } = await adminClient
        .from("fixtures")
        .select("id", { count: "exact", head: true })
        .eq("competition_external_id", (await getExternalLeagueId(adminClient, job.league_season_import_id)) ?? "")
        .gt("scheduled_start_utc", new Date().toISOString());

      await adminClient
        .from("league_season_imports")
        .update({
          import_status: "IMPORTED",
          imported_at: new Date().toISOString(),
          fixture_count_imported: recalculated.processed_fixtures,
          upcoming_fixture_count: upcomingCount ?? 0,
          completed_fixture_count: Math.max(0, recalculated.processed_fixtures - (upcomingCount ?? 0)),
          last_synced_at: new Date().toISOString(),
          last_fixture_discovery_at: new Date().toISOString(),
          sync_status: "IDLE",
        })
        .eq("id", job.league_season_import_id);
    } else if (recalculated.status === "FAILED") {
      result.jobsFinalized += 1;
      await adminClient
        .from("league_season_imports")
        .update({ import_status: "IMPORT_FAILED" })
        .eq("id", job.league_season_import_id);
    }
  }

  const { data: cleanedCount } = await adminClient.rpc("cleanup_import_job_chunk_payloads", {
    p_recovery_window: CHUNK_PAYLOAD_RECOVERY_WINDOW,
  });
  result.chunkPayloadsCleaned = cleanedCount ?? 0;

  return result;
}

async function getExternalLeagueId(
  adminClient: ReturnType<typeof createAdminClient>,
  leagueSeasonImportId: string,
): Promise<string | null> {
  const { data } = await adminClient
    .from("league_season_imports")
    .select("external_league_id")
    .eq("id", leagueSeasonImportId)
    .single();
  return data?.external_league_id ?? null;
}
