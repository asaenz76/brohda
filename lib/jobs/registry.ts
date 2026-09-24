/**
 * Milestone R13.9 — the single source of truth for every production
 * lifecycle job's identity and technical metadata. Before this, the
 * admin dashboard (lib/reports/fetch.ts) hard-coded its own 3-entry job
 * list, independently of the actual `job_name` strings each
 * app/api/cron/*\/route.ts passes to recordJobRun() — it had already
 * drifted (it named "sync-fixtures", the real recorded name is
 * "sync-fixtures-nfl", so that job's health silently showed "never run"
 * indefinitely). This registry is read by lib/jobs/health.ts to compute
 * dashboard status and is the only place a job's id/route/cadence is
 * declared in application code.
 *
 * `expectedCadenceMinutes` is a technical/architectural fact (how often
 * this job is *meant* to run, per docs/DEPLOYMENT.md's own cron table) —
 * not an operator-tunable value. What operators may reasonably want to
 * tune is the tolerance before a job is flagged stale; that's the single
 * `platform_settings.job_staleness_multiplier` knob (20260101000166),
 * applied uniformly against every job's own cadence here.
 */

export type JobCategory = "legacy" | "infra" | "brohda-social" | "brohda-monetary";
export type JobCriticality = "critical" | "standard";

export interface JobDefinition {
  /** Exact string passed to recordJobRun() and stored as background_jobs.job_name. */
  id: string;
  displayName: string;
  route: string;
  category: JobCategory;
  criticality: JobCriticality;
  /** Documented recommended cadence in minutes — see docs/DEPLOYMENT.md §5. */
  expectedCadenceMinutes: number;
}

export const JOB_REGISTRY: readonly JobDefinition[] = [
  {
    id: "lock-pools",
    displayName: "Lock pools",
    route: "/api/cron/lock-pools",
    category: "legacy",
    criticality: "critical",
    expectedCadenceMinutes: 1,
  },
  {
    id: "process-results",
    displayName: "Process pool results",
    route: "/api/cron/process-results",
    category: "legacy",
    criticality: "critical",
    expectedCadenceMinutes: 1,
  },
  {
    id: "sync-fixtures-nfl",
    displayName: "Sync NFL fixtures",
    route: "/api/cron/sync-fixtures-nfl",
    category: "infra",
    criticality: "standard",
    expectedCadenceMinutes: 5,
  },
  {
    id: "prune-provider-request-log",
    displayName: "Prune provider request log",
    route: "/api/cron/prune-provider-request-log",
    category: "infra",
    criticality: "standard",
    expectedCadenceMinutes: 5,
  },
  {
    id: "ingest-nfl-markets",
    displayName: "Ingest NFL markets",
    route: "/api/cron/ingest-nfl-markets",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 15,
  },
  {
    id: "publish-posts",
    displayName: "Publish posts",
    route: "/api/cron/publish-posts",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 5,
  },
  {
    id: "distribute-posts",
    displayName: "Distribute posts to communities",
    route: "/api/cron/distribute-posts",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 10,
  },
  {
    id: "grade-predictions",
    displayName: "Grade predictions",
    route: "/api/cron/grade-predictions",
    category: "brohda-social",
    criticality: "critical",
    expectedCadenceMinutes: 2,
  },
  {
    id: "resolve-challenges",
    displayName: "Resolve Call BS challenges",
    route: "/api/cron/resolve-challenges",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 2,
  },
  {
    id: "settle-monetary-positions",
    displayName: "Settle monetary positions",
    route: "/api/cron/settle-monetary-positions",
    category: "brohda-monetary",
    criticality: "critical",
    expectedCadenceMinutes: 2,
  },
] as const;
