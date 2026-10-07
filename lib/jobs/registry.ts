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

export type JobCategory = "infra" | "brohda-social" | "brohda-monetary";
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
    // Sponsorship housekeeping (SCHEDULED -> LIVE -> COMPLETED, expired unpaid holds). Public rendering re-verifies eligibility on every read, so this only
    // keeps stored labels current; it needs its own external cron entry (docs/DEPLOYMENT.md §5).
    id: "advance-sponsorships",
    displayName: "Advance sponsorships",
    route: "/api/cron/advance-sponsorships",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 5,
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
    // Real-production incident fix (Stage 4C, R13.10): this job's own
    // eligibility query was unbounded (every not-yet-started fixture for
    // the rest of the season, not just this week), and at the old
    // 15-minute external cron-job.org schedule that meant ~21,700 real
    // `get_odds` provider requests/day — ~3x the entire API-NFL PRO
    // plan's 7,500/day limit. The query itself is now bounded to the
    // current sportsbook week (lib/prediction-markets/ingestion/nfl.ts's
    // listEligibleNflFixtures), but the OTHER half of the fix — reducing
    // the actual trigger frequency from every 15 minutes to once daily —
    // lives in cron-job.org's own external schedule, not in this
    // repository; this cadence value must match whatever that schedule
    // is actually set to, since it's read only for staleness detection
    // (Job Health), never for triggering the job itself.
    id: "ingest-nfl-markets",
    displayName: "Ingest NFL markets",
    route: "/api/cron/ingest-nfl-markets",
    category: "brohda-social",
    criticality: "standard",
    expectedCadenceMinutes: 1440,
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
