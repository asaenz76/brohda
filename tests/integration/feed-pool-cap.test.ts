/**
 * Integration test for the Feed page's defensive .limit(50) cap
 * (app/(app)/feed/page.tsx) — specifically that the cap orders by
 * whichever field the active sort mode needs *before* limiting, so
 * "locking soon" surfaces the genuinely soonest-to-lock pools rather than
 * just re-sorting whatever the 50 newest happen to be. Runs the exact same
 * query shape the page uses, directly against the pools table.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`) —
 * pointed at LOCAL Supabase only, never .env.local (see
 * tests/integration/pool-bulk-rpc.test.ts for why).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const FEED_PAGE_SIZE = 50;
const POOL_COUNT = 60;

const createdPoolIds: string[] = [];
let fixtureId: string;
let adminId: string;

describe.skipIf(!SERVICE_ROLE_KEY)("Feed pool cap (order-before-limit)", () => {
  beforeAll(async () => {
    const { data: adminRow } = await admin
      .from("user_profiles")
      .select("id")
      .eq("role", "super_admin")
      .eq("is_active", true)
      .limit(1)
      .single();
    adminId = adminRow!.id as string;

    const { data: fixture, error: fixtureError } = await admin
      .from("fixtures")
      .insert({
        external_fixture_id: `feed-cap-test-${randomUUID()}`,
        home_team_name: "Home Test FC",
        away_team_name: "Away Test FC",
        scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        internal_status: "NOT_STARTED",
      })
      .select("id")
      .single();
    if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create test fixture");
    fixtureId = fixture.id as string;

    // i = 0..59. created_at increases with i (i=59 is newest); locks_at
    // increases with i too, but starting from now (i=0 locks soonest,
    // i=59 locks last) — so "newest" and "soonest to lock" pick opposite
    // ends of the same sequence, deliberately non-overlapping at the
    // extremes, so a bug that always orders by created_at regardless of
    // sort mode is caught rather than accidentally passing.
    const now = Date.now();
    const rows = Array.from({ length: POOL_COUNT }, (_, i) => ({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "WHO_WILL_ADVANCE",
      question: `Feed cap test pool ${i}`,
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      visibility: "VISIBLE_TO_ALL_MEMBERS",
      status: "OPEN",
      open_at: new Date(now - (POOL_COUNT - i) * 60_000).toISOString(),
      created_at: new Date(now - (POOL_COUNT - i) * 60_000).toISOString(),
      locks_at: new Date(now + (i + 1) * 60_000).toISOString(),
    }));

    const { data: pools, error } = await admin.from("pools").insert(rows).select("id");
    if (error || !pools) throw error ?? new Error("failed to seed test pools");
    createdPoolIds.push(...pools.map((p) => p.id as string));
  });

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (fixtureId) {
      await admin.from("fixtures").delete().eq("id", fixtureId);
    }
  });

  function runFeedQuery(sortByLockingSoon: boolean) {
    return admin
      .from("pools")
      .select("id, created_at, locks_at")
      .in("id", createdPoolIds)
      .eq("visibility", "VISIBLE_TO_ALL_MEMBERS")
      .eq("status", "OPEN")
      .order(sortByLockingSoon ? "locks_at" : "created_at", { ascending: sortByLockingSoon })
      .limit(FEED_PAGE_SIZE);
  }

  it("newest-first mode returns exactly 50 rows, the 50 most recently created", async () => {
    const { data, error } = await runFeedQuery(false);
    expect(error).toBeNull();
    expect(data).toHaveLength(FEED_PAGE_SIZE);

    // Cross-check against a direct query for the true newest 50 among all
    // seeded pools.
    const { data: expected } = await admin
      .from("pools")
      .select("id")
      .in("id", createdPoolIds)
      .order("created_at", { ascending: false })
      .limit(FEED_PAGE_SIZE);

    expect(new Set(data!.map((r) => r.id))).toEqual(new Set(expected!.map((r) => r.id)));
  });

  it("locking-soon mode returns exactly 50 rows, the 50 genuinely soonest to lock — not the 50 newest re-sorted", async () => {
    const { data, error } = await runFeedQuery(true);
    expect(error).toBeNull();
    expect(data).toHaveLength(FEED_PAGE_SIZE);

    const { data: expected } = await admin
      .from("pools")
      .select("id")
      .in("id", createdPoolIds)
      .order("locks_at", { ascending: true })
      .limit(FEED_PAGE_SIZE);

    expect(new Set(data!.map((r) => r.id))).toEqual(new Set(expected!.map((r) => r.id)));

    // The two sort modes must disagree at the extremes — proves this test
    // would actually fail if the cap ignored sort mode: the oldest-created
    // pool (soonest to lock) must appear in "locking soon" but not
    // "newest"; the newest-created pool (latest to lock) must appear in
    // "newest" but not "locking soon".
    const { data: newest } = await runFeedQuery(false);
    const lockingSoonIds = new Set(data!.map((r) => r.id));
    const newestIds = new Set(newest!.map((r) => r.id));

    const oldestCreatedPoolId = createdPoolIds[0]; // i=0: oldest created, soonest to lock
    const newestCreatedPoolId = createdPoolIds[POOL_COUNT - 1]; // i=59: newest created, latest to lock

    expect(lockingSoonIds.has(oldestCreatedPoolId)).toBe(true);
    expect(newestIds.has(oldestCreatedPoolId)).toBe(false);
    expect(newestIds.has(newestCreatedPoolId)).toBe(true);
    expect(lockingSoonIds.has(newestCreatedPoolId)).toBe(false);
  });
});
