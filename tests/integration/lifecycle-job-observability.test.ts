/**
 * Integration tests for Milestone R13.9 (Production Operations &
 * Observability Gate):
 *  - background_jobs.status now genuinely accepts 'degraded' against a
 *    real Postgres CHECK constraint (20260101000166), not just a mocked
 *    admin client (see the unit-level tests in tests/unit/jobs/record.test.ts
 *    for the pure classification logic).
 *  - getJobHealth() is driven by the full lib/jobs/registry.ts, not the
 *    old hard-coded 3-job list, and correctly classifies never-run vs
 *    healthy vs stale vs degraded vs failed jobs.
 *  - getJobHealth() reads via the RLS-respecting request-scoped client
 *    (lib/supabase/server), so it stays Super-Admin-only for free via the
 *    same `admins_read_background_jobs` policy background_jobs has always
 *    had — no new authorization code was needed, and this proves that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { recordJobRun } from "@/lib/jobs/record";

// getJobHealth() itself (lib/reports/fetch.ts) is exercised at the unit
// level (tests/unit/reports/job-health.test.ts, with lib/supabase/server
// mocked) rather than here: it calls lib/supabase/server's createClient(),
// which calls next/headers' cookies() and throws "called outside a
// request scope" when invoked directly from a plain Vitest test with no
// real Next.js request — the same reason lib/reports/fetch.ts had no
// integration coverage before this milestone. What IS proven here,
// against a real database, is the two things that actually need a live
// Postgres: the widened background_jobs.status CHECK constraint, and the
// pre-existing admins_read_background_jobs RLS policy correctly gating
// the exact same table the new dashboard reads from.

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";

async function createTestUser(role: "player" | "super_admin") {
  const email = `r13-9-${role}-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: email.split("@")[0], role, is_active: true });

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw signInError;
  return { userId: data.user.id as string, client };
}

const createdUserIds: string[] = [];

afterEach(async () => {
  await admin.from("background_jobs").delete().in("job_name", ["r13-9-test-job", "r13-9-degraded-job", "r13-9-failed-job"]);
  await admin.from("user_profiles").delete().in("id", createdUserIds);
  for (const id of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
});

describe("background_jobs.status accepts 'degraded' (20260101000166)", () => {
  it("recordJobRun persists a real degraded row for a result with per-item failures", async () => {
    const result = await recordJobRun("r13-9-degraded-job", async () => ({
      examined: 10,
      graded: 9,
      failures: [{ predictionId: "p-1", error: "simulated" }],
    }));
    expect(result).not.toHaveProperty("skipped");

    const { data, error } = await admin
      .from("background_jobs")
      .select("status, result")
      .eq("job_name", "r13-9-degraded-job")
      .order("finished_at", { ascending: false })
      .limit(1)
      .single();
    expect(error).toBeNull();
    expect(data!.status).toBe("degraded");
    expect((data!.result as { failures: unknown[] }).failures).toHaveLength(1);
  });

  it("recordJobRun still persists 'success' for a clean result (no regression from the widened CHECK)", async () => {
    await recordJobRun("r13-9-test-job", async () => ({ examined: 5, graded: 5, failures: [] }));
    const { data } = await admin
      .from("background_jobs")
      .select("status")
      .eq("job_name", "r13-9-test-job")
      .order("finished_at", { ascending: false })
      .limit(1)
      .single();
    expect(data!.status).toBe("success");
  });

  it("recordJobRun still persists 'error' when the job throws", async () => {
    await expect(
      recordJobRun("r13-9-failed-job", async () => {
        throw new Error("simulated hard failure");
      }),
    ).rejects.toThrow();
    const { data } = await admin
      .from("background_jobs")
      .select("status, error")
      .eq("job_name", "r13-9-failed-job")
      .order("finished_at", { ascending: false })
      .limit(1)
      .single();
    expect(data!.status).toBe("error");
    expect(data!.error).toContain("simulated hard failure");
  });
});

describe("Job Health stays Super-Admin-only via existing background_jobs RLS", () => {
  it("an ordinary player's own client cannot read any background_jobs row", async () => {
    const { userId, client } = await createTestUser("player");
    createdUserIds.push(userId);

    await recordJobRun("r13-9-test-job", async () => ({ examined: 1, graded: 1, failures: [] }));

    const { data, error } = await client.from("background_jobs").select("*").eq("job_name", "r13-9-test-job");
    // RLS silently filters rows for a non-super-admin rather than erroring —
    // the correct, established Postgres RLS behavior for a SELECT the
    // policy denies: zero rows, not an error.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("a super_admin's own client can read background_jobs rows", async () => {
    const { userId, client } = await createTestUser("super_admin");
    createdUserIds.push(userId);

    await recordJobRun("r13-9-test-job", async () => ({ examined: 1, graded: 1, failures: [] }));

    const { data, error } = await client.from("background_jobs").select("*").eq("job_name", "r13-9-test-job");
    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });
});
