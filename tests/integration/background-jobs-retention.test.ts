/**
 * Integration tests for cron run-history retention (migration 195's delete_old_background_jobs_rows + lib/jobs/retention.ts). Real local Supabase.
 *
 * Every test uses its own unique job names, so what is asserted is exactly what retention did to those rows. The function itself walks every job name in
 * the table (that is its job), so these tests only ever assert on their own rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";
import { BACKGROUND_JOBS_KEEP_LATEST_PER_JOB, runBackgroundJobsRetention } from "@/lib/jobs/retention";

const admin = getTestAdminClient();
const DAY_MS = 86_400_000;

const jobNames: string[] = [];
const providerLogIds: string[] = [];
let savedRetention: number | null = null;

function uniqueJob(label: string): string {
  const name = `retention-test-${label}-${crypto.randomUUID().slice(0, 8)}`;
  jobNames.push(name);
  return name;
}

/** `agesMs` are how long ago each row finished; every row gets a distinct, deterministic finished_at. */
async function insertRuns(jobName: string, agesMs: number[]): Promise<void> {
  const now = Date.now();
  const rows = agesMs.map((age) => ({
    job_name: jobName,
    status: "success",
    started_at: new Date(now - age - 1_000).toISOString(),
    finished_at: new Date(now - age).toISOString(),
    duration_ms: 1,
  }));
  for (let i = 0; i < rows.length; i += 1_000) {
    const { error } = await admin.from("background_jobs").insert(rows.slice(i, i + 1_000));
    if (error) throw error;
  }
}

async function countRuns(jobName: string): Promise<number> {
  const { count, error } = await admin.from("background_jobs").select("id", { count: "exact", head: true }).eq("job_name", jobName);
  if (error) throw error;
  return count ?? 0;
}

async function setRetention(days: number): Promise<void> {
  const { error } = await admin.from("platform_settings").update({ background_job_retention_days: days }).eq("id", true);
  if (error) throw error;
}

/** Drains retention exactly as the cron would across ticks. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const result = await runBackgroundJobsRetention();
    if (result.rowsDeleted === 0) return;
  }
}

beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select("background_job_retention_days").eq("id", true).single();
  savedRetention = data?.background_job_retention_days ?? null;
  await setRetention(14);
});

afterEach(async () => {
  if (savedRetention !== null) await setRetention(savedRetention);
  if (jobNames.length > 0) {
    await admin.from("background_jobs").delete().in("job_name", jobNames);
    jobNames.length = 0;
  }
  if (providerLogIds.length > 0) {
    await admin.from("provider_request_log").delete().in("id", providerLogIds);
    providerLogIds.length = 0;
  }
});

describe("background_jobs retention", () => {
  it("deletes only rows older than the window, keeps rows inside it, and the boundary is exactly the retention days", async () => {
    const job = uniqueJob("boundary");
    // 60 recent runs fill the protected "newest 50", so the age rule alone decides the older rows.
    const recent = Array.from({ length: 60 }, (_, i) => (i + 1) * 60_000);
    await insertRuns(job, [...recent, 13 * DAY_MS + 23 * 3_600_000, 14 * DAY_MS + 3_600_000, 30 * DAY_MS]);

    await drain();

    // 60 recent + the 13d23h row survive; the 14d1h and 30d rows are gone.
    expect(await countRuns(job)).toBe(61);
    const { data: oldest } = await admin.from("background_jobs").select("finished_at").eq("job_name", job).order("finished_at", { ascending: true }).limit(1).single();
    const oldestAgeDays = (Date.now() - new Date(oldest!.finished_at).getTime()) / DAY_MS;
    expect(oldestAgeDays).toBeGreaterThan(13.9);
    expect(oldestAgeDays).toBeLessThan(14);
  });

  it("always keeps the newest 50 rows of a job, however old they are", async () => {
    const job = uniqueJob("newest50");
    // 70 runs, every one far older than the window.
    await insertRuns(job, Array.from({ length: 70 }, (_, i) => (60 + i) * DAY_MS));

    await drain();

    expect(await countRuns(job)).toBe(BACKGROUND_JOBS_KEEP_LATEST_PER_JOB);
    // They are the NEWEST 50: the oldest survivor is the 50th-newest run (age 60 + 49 days).
    const { data: oldest } = await admin.from("background_jobs").select("finished_at").eq("job_name", job).order("finished_at", { ascending: true }).limit(1).single();
    const oldestAgeDays = Math.round((Date.now() - new Date(oldest!.finished_at).getTime()) / DAY_MS);
    expect(oldestAgeDays).toBe(60 + 49);
  });

  it("leaves a job with fewer than 50 rows completely alone, however old (a discontinued job keeps its last known runs)", async () => {
    const job = uniqueJob("fewrows");
    await insertRuns(job, Array.from({ length: 30 }, (_, i) => (100 + i) * DAY_MS));

    await drain();

    expect(await countRuns(job)).toBe(30);
  });

  it("works one bounded batch at a time: a call never deletes more than the batch size", async () => {
    const job = uniqueJob("batch");
    // 150 rows, 100 of them old and beyond the newest 50.
    await insertRuns(job, [...Array.from({ length: 50 }, (_, i) => (i + 1) * 60_000), ...Array.from({ length: 100 }, (_, i) => (30 + i) * DAY_MS)]);

    const first = await admin.rpc("delete_old_background_jobs_rows", { p_retention_days: 14, p_batch_size: 10, p_keep_latest_per_job: 50 });
    expect(first.error).toBeNull();
    // The function walks every job name, so the shared batch may have been spent on other jobs' old rows; it can never exceed the batch size.
    expect(first.data).toBeLessThanOrEqual(10);
    expect(first.data).toBeGreaterThan(0);
    expect(await countRuns(job)).toBeGreaterThanOrEqual(50);
  });

  it("drains a large backlog over successive batches and reports the batches it ran", async () => {
    const job = uniqueJob("backlog");
    // 2,300 old rows: 1,000 + 1,000 + 250 deletable, plus the protected 50 (the 50 newest of the 2,300).
    await insertRuns(job, Array.from({ length: 2_300 }, (_, i) => (20 + i / 100) * DAY_MS + i * 1_000));

    const result = await runBackgroundJobsRetention();

    expect(result.retentionDays).toBe(14);
    expect(result.batchesRun).toBeGreaterThanOrEqual(3);
    expect(result.rowsDeleted).toBeGreaterThanOrEqual(2_250);
    expect(await countRuns(job)).toBe(50);
  });

  it("deletes nothing outside background_jobs", async () => {
    const job = uniqueJob("scope");
    await insertRuns(job, Array.from({ length: 80 }, (_, i) => (40 + i) * DAY_MS));

    // An old provider_request_log row (its own retention is a different job) and the cron lock table must be untouched by run-history retention.
    const oldLog = new Date(Date.now() - 90 * DAY_MS).toISOString();
    const { data: logRow, error: logError } = await admin
      .from("provider_request_log")
      .insert({ provider: "api_nfl", request_type: "retention-scope-test", response_status: 200, duration_ms: 1, created_at: oldLog })
      .select("id")
      .single();
    if (logError || !logRow) throw logError ?? new Error("could not insert a provider_request_log row");
    providerLogIds.push(logRow.id);
    const { count: locksBefore } = await admin.from("cron_job_locks").select("job_name", { count: "exact", head: true });

    await drain();

    const { count: logAfter } = await admin.from("provider_request_log").select("id", { count: "exact", head: true }).eq("id", logRow.id);
    expect(logAfter).toBe(1);
    const { count: locksAfter } = await admin.from("cron_job_locks").select("job_name", { count: "exact", head: true });
    expect(locksAfter).toBe(locksBefore);
    expect(await countRuns(job)).toBe(50);
  });

  it("the database refuses a nonsensical retention window", async () => {
    for (const bad of [0, -3, 3651]) {
      const { error } = await admin.from("platform_settings").update({ background_job_retention_days: bad }).eq("id", true);
      expect(error, `retention ${bad} must be rejected`).not.toBeNull();
    }
  });

  it("is not callable by signed-in users or the public", async () => {
    const { getTestAnonClient } = await import("./helpers/test-env");
    const anon = getTestAnonClient();
    const { error } = await anon.rpc("delete_old_background_jobs_rows", { p_retention_days: 1, p_batch_size: 1, p_keep_latest_per_job: 1 });
    expect(error).not.toBeNull();
  });
});
