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
  // Jobs found and finalized by the reconciliation pass specifically —
  // i.e. jobs that reached SUCCEEDED/FAILED without ever being finalized
  // by the tick that got them there. Always <= jobsFinalized; broken out
  // so this previously-silent gap stays visible instead of blending back
  // into the same counter that hides it.
  jobsReconciled: number;
}

/**
 * Applies the terminal outcome of one job (however it got there — a chunk
 * this same tick just processed, or one found stuck by the reconciliation
 * pass below) to its league_season_imports row. Idempotent: recalculating
 * an already-IMPORTED job's progress is harmless (still SUCCEEDED, same
 * fields recomputed to the same values), so this is always safe to call,
 * never just on a first discovery.
 */
async function finalizeJobIfTerminal(
  adminClient: ReturnType<typeof createAdminClient>,
  jobId: string,
): Promise<"finalized-succeeded" | "finalized-failed" | "not-terminal-yet"> {
  const { data: job } = await adminClient
    .from("competition_import_jobs")
    .select("id, max_attempts, league_season_import_id")
    .eq("id", jobId)
    .single();
  if (!job) return "not-terminal-yet";

  const { data: recalculated } = await adminClient.rpc("recalculate_import_job_progress", {
    p_job_id: jobId,
    p_max_attempts: job.max_attempts,
  });
  if (!recalculated) return "not-terminal-yet";

  if (recalculated.status === "SUCCEEDED") {
    // Phase 4.1: a query failure anywhere in this block used to fall
    // through silently — getExternalLeagueId returning null on a real DB
    // error (not just "row genuinely missing," which can't happen for a
    // job's own valid league_season_import_id foreign key) made the
    // upcomingCount/latestFixtureRow queries below filter on
    // competition_external_id = "", matching zero rows, and PERSIST
    // upcoming_fixture_count: 0 into league_season_imports for a
    // genuinely-successful import with real upcoming fixtures. That's
    // worse than a display glitch — it's a wrong value written to the row
    // every other view reads from afterward. Bailing to "not-terminal-yet"
    // is always safe here: this function is explicitly documented as
    // idempotent and re-run every tick, so skipping a write this tick
    // just means the next tick tries again with (presumably) working
    // queries, never a stuck state.
    const externalLeagueId = await getExternalLeagueId(adminClient, job.league_season_import_id);
    if (externalLeagueId == null) return "not-terminal-yet";

    const upcomingResult = await adminClient
      .from("fixtures")
      .select("id", { count: "exact", head: true })
      .eq("competition_external_id", externalLeagueId)
      .gt("scheduled_start_utc", new Date().toISOString());
    // The synchronous single-chunk path (startCompetitionImportAction)
    // computes this straight from its in-memory provider fetch; a
    // multi-chunk import finishes here instead, across separate cron
    // ticks with nothing held in memory, so it's derived the same way
    // discovery-sync does — the max scheduled date actually persisted —
    // rather than left null. Left null, isCompleted() could never
    // confirm a real completion for any multi-chunk import until its
    // first discovery sync, which is safe (never a false positive) but
    // needlessly conservative.
    const latestFixtureResult = await adminClient
      .from("fixtures")
      .select("scheduled_start_utc")
      .eq("competition_external_id", externalLeagueId)
      .order("scheduled_start_utc", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (upcomingResult.error || latestFixtureResult.error) {
      console.error("[finalizeJobIfTerminal] failed to compute fixture counts, deferring finalization to next tick", {
        upcomingError: upcomingResult.error,
        latestFixtureError: latestFixtureResult.error,
        leagueSeasonImportId: job.league_season_import_id,
      });
      return "not-terminal-yet";
    }
    const upcomingCount = upcomingResult.count;
    const latestFixtureRow = latestFixtureResult.data;

    await adminClient
      .from("league_season_imports")
      .update({
        import_status: "IMPORTED",
        imported_at: new Date().toISOString(),
        fixture_count_imported: recalculated.processed_fixtures,
        upcoming_fixture_count: upcomingCount ?? 0,
        completed_fixture_count: Math.max(0, recalculated.processed_fixtures - (upcomingCount ?? 0)),
        provider_fixture_count: recalculated.processed_fixtures,
        latest_provider_fixture_at: latestFixtureRow?.scheduled_start_utc ?? null,
        last_synced_at: new Date().toISOString(),
        last_fixture_discovery_at: new Date().toISOString(),
        sync_status: "IDLE",
      })
      .eq("id", job.league_season_import_id);
    return "finalized-succeeded";
  }

  if (recalculated.status === "FAILED") {
    await adminClient.from("league_season_imports").update({ import_status: "IMPORT_FAILED" }).eq("id", job.league_season_import_id);
    return "finalized-failed";
  }

  return "not-terminal-yet";
}

/**
 * Reconciliation pass: finds any league_season_imports row still marked
 * IMPORTING whose import job has already reached a terminal chunk state
 * (every chunk SUCCEEDED or FAILED, none PENDING/RUNNING) and finalizes
 * it. This closes a real gap the normal per-tick claim loop below doesn't
 * cover on its own — that loop only finalizes a job if *this* invocation
 * is the one that claims the job's last chunk (via `affectedJobIds`), so
 * a job whose final chunk was claimed and processed by a different
 * invocation (a concurrent tick, another job's synchronous first-chunk
 * claim via startCompetitionImportAction — claim_import_job_chunks claims
 * across every in-flight job, not scoped to the caller's own job, so this
 * cross-claiming is a real, observed scenario, not hypothetical) never
 * gets revisited, leaving its league_season_imports row stuck IMPORTING
 * indefinitely even though every chunk succeeded. Runs every tick
 * regardless of what the claim loop did this time, so finalization no
 * longer depends on which specific tick happened to claim the last chunk.
 * Idempotent and cheap: `league_season_imports.import_status = 'IMPORTING'`
 * is a small, transient set at any given time, not the whole table.
 */
async function reconcileStuckImportingRows(adminClient: ReturnType<typeof createAdminClient>): Promise<number> {
  const { data: stillImporting } = await adminClient
    .from("league_season_imports")
    .select("id")
    .eq("import_status", "IMPORTING");
  if (!stillImporting || stillImporting.length === 0) return 0;

  let reconciled = 0;
  for (const lsi of stillImporting) {
    // The job's own `status` column can itself be stale — it's only ever
    // updated when recalculate_import_job_progress runs, which is exactly
    // the step that can go missing for the reason documented above. So
    // this looks at chunk terminality directly (the real source of
    // truth), not job.status, then calls finalizeJobIfTerminal — which
    // runs recalculate_import_job_progress itself and will correctly
    // flip the job's own status as a side effect.
    const { data: job } = await adminClient
      .from("competition_import_jobs")
      .select("id")
      .eq("league_season_import_id", lsi.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job) continue;

    const { data: chunks } = await adminClient
      .from("competition_import_job_chunks")
      .select("status")
      .eq("job_id", job.id);
    const allTerminal = (chunks ?? []).length > 0 && (chunks ?? []).every((c) => c.status === "SUCCEEDED" || c.status === "FAILED");
    if (!allTerminal) continue; // genuinely still in flight — leave it for a later tick

    const outcome = await finalizeJobIfTerminal(adminClient, job.id);
    if (outcome === "finalized-succeeded" || outcome === "finalized-failed") reconciled++;
  }
  return reconciled;
}

/**
 * One tick of the competition-import background processor — claims a
 * bounded batch of processable chunks (across every in-flight job, via
 * claim_import_job_chunks' FOR UPDATE SKIP LOCKED), persists each one,
 * recalculates every affected job's progress from chunk state, and
 * finalizes league_season_imports for any job that just reached a
 * terminal status. Then runs the reconciliation pass above, so a job
 * that reached SUCCEEDED/FAILED without this tick's claim loop noticing
 * (see reconcileStuckImportingRows) still gets finalized. Also reclaims
 * old succeeded-chunk payloads. Safe to run concurrently with itself
 * (claiming is what makes that safe) and safe to re-run after a partial
 * failure (every write here is either idempotent or driven by
 * recalculation, never a blind increment). Makes zero provider calls —
 * every fixture this persists was already fetched and staged into a
 * chunk's payload at import-start time.
 */
export async function runCompetitionImportProcessing(): Promise<ProcessImportsResult> {
  const adminClient = createAdminClient();
  const result: ProcessImportsResult = {
    chunksClaimed: 0,
    chunksSucceeded: 0,
    chunksFailed: 0,
    jobsFinalized: 0,
    chunkPayloadsCleaned: 0,
    jobsReconciled: 0,
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
    const outcome = await finalizeJobIfTerminal(adminClient, jobId);
    if (outcome === "finalized-succeeded" || outcome === "finalized-failed") result.jobsFinalized += 1;
  }

  result.jobsReconciled = await reconcileStuckImportingRows(adminClient);
  result.jobsFinalized += result.jobsReconciled;

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
  const { data, error } = await adminClient
    .from("league_season_imports")
    .select("external_league_id")
    .eq("id", leagueSeasonImportId)
    .single();
  // A null return here should only ever happen on a genuine query
  // failure — the caller always passes a job's own league_season_import_id,
  // a valid foreign key that's guaranteed to have a matching row. Logging
  // the real error distinguishes that from the (should-be-impossible)
  // case of the row itself being gone.
  if (error) console.error("[getExternalLeagueId] query failed", { error, leagueSeasonImportId });
  return data?.external_league_id ?? null;
}
