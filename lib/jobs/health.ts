import type { JobDefinition } from "./registry";

/**
 * Milestone R13.9 — pure, unit-testable job-health computation, shared by
 * lib/reports/fetch.ts (admin dashboard) and lib/jobs/record.ts (degraded-
 * status detection at write time).
 */

export type JobHealthStatus = "never_run" | "healthy" | "no_op_healthy" | "stale" | "degraded" | "failed";

export interface BackgroundJobRow {
  job_name: string;
  status: string;
  result: unknown;
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface JobHealthEntry {
  job: JobDefinition;
  status: JobHealthStatus;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  lastResultSummary: string | null;
  lastError: string | null;
  durationMs: number | null;
}

/**
 * Duck-typed on purpose: every Brohda 2.0 lifecycle job's own result type
 * (GradingRunSummary, ChallengeResolutionRunSummary, SettlementRunSummary,
 * MarketIngestionSummary, PostPublicationSummary, CommunityDistribution
 * Summary) already independently converged on a `failures: Array<...>`
 * shape, and settlement additionally has `invariantViolations`. Several
 * legacy jobs (lockDuePools, processAwaitingResults, runNflFixtureSync)
 * use a `failed: number` counter instead. This checks exactly those
 * already-established field names — it does not invent new job-result
 * semantics, and it deliberately does not fabricate a schema for jobs
 * that genuinely don't have one.
 */
export function isDegradedResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.failures) && r.failures.length > 0) return true;
  if (typeof r.invariantViolations === "number" && r.invariantViolations > 0) return true;
  if (typeof r.failed === "number" && r.failed > 0) return true;
  return false;
}

/** True only for the three flag-gated Brohda 2.0 jobs whose own result
 * shape reports whether their platform_settings flag was off this run
 * (MarketIngestionSummary/PostPublicationSummary/CommunityDistribution
 * Summary's `policyEnabled: boolean`). Absent on every other job's result
 * — those jobs have no such flag, so this can never misclassify them. */
function isPolicyDisabledResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return (result as Record<string, unknown>).policyEnabled === false;
}

function summarizeResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.examined === "number") parts.push(`${r.examined} examined`);
  if (typeof r.checked === "number") parts.push(`${r.checked} checked`);
  if (typeof r.candidates === "number") parts.push(`${r.candidates} candidates`);
  if (Array.isArray(r.failures) && r.failures.length > 0) parts.push(`${r.failures.length} failed`);
  if (typeof r.failed === "number" && r.failed > 0) parts.push(`${r.failed} failed`);
  if (typeof r.invariantViolations === "number" && r.invariantViolations > 0) {
    parts.push(`${r.invariantViolations} invariant violation${r.invariantViolations === 1 ? "" : "s"}`);
  }
  if (r.policyEnabled === false) parts.push("feature disabled");
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * `rows` must already be sorted newest-first by finished_at, and should
 * cover a comfortable recent window across every job (lib/reports/
 * fetch.ts fetches the most recent N rows across ALL jobs, not per-job,
 * since 10 jobs firing every 1-15 minutes make a single shared query
 * sufficient — see getJobHealth()).
 */
export function computeJobHealth(
  job: JobDefinition,
  rows: readonly BackgroundJobRow[],
  now: Date,
  stalenessMultiplier: number,
): JobHealthEntry {
  const jobRows = rows.filter((r) => r.job_name === job.id);
  const latest = jobRows[0];

  if (!latest) {
    return {
      job,
      status: "never_run",
      lastAttemptedAt: null,
      lastSuccessfulAt: null,
      lastResultSummary: null,
      lastError: null,
      durationMs: null,
    };
  }

  const lastSuccessful = jobRows.find((r) => r.status === "success" || r.status === "degraded");

  const staleAfterMs = job.expectedCadenceMinutes * stalenessMultiplier * 60_000;
  const isStale = now.getTime() - new Date(latest.finished_at).getTime() > staleAfterMs;

  const base = {
    job,
    lastAttemptedAt: latest.finished_at,
    lastSuccessfulAt: lastSuccessful?.finished_at ?? null,
    lastResultSummary: summarizeResult(latest.result),
    lastError: latest.error,
    durationMs: latest.duration_ms,
  };

  if (latest.status === "error") {
    return { ...base, status: "failed" };
  }

  // Staleness is evaluated before result-shape classification: a run
  // that finished long ago is stale regardless of what it reported,
  // including a stale no-op (the scheduler itself may have stopped
  // firing, which "the feature happens to be disabled" must never mask).
  if (isStale) {
    return { ...base, status: "stale" };
  }

  if (latest.status === "degraded") {
    return { ...base, status: "degraded" };
  }

  if (isPolicyDisabledResult(latest.result)) {
    return { ...base, status: "no_op_healthy" };
  }

  return { ...base, status: "healthy" };
}
