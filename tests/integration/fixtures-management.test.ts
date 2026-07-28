/**
 * Integration tests for fixture management: the
 * fixtures_available_for_pool_creation view (excludes a fixture once every
 * pool referencing it has been graded, or once the fixture itself reaches a
 * terminal status — COMPLETED/CANCELLED/ABANDONED/AWARDED — regardless of
 * whether it has any pools at all) and the FK-level guard that backs
 * deleteFixtureAction (a fixture with any pool attached can't be deleted).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getAdminId(): Promise<string> {
  const { data } = await admin
    .from("user_profiles")
    .select("id")
    .eq("role", "super_admin")
    .eq("is_active", true)
    .limit(1)
    .single();
  return data!.id as string;
}

async function createTestFixture(internalStatus = "NOT_STARTED"): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `fixtures-mgmt-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: internalStatus,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data.id as string;
}

const createdFixtureIds: string[] = [];
const createdPoolIds: string[] = [];

async function createPool(fixtureId: string, adminId: string, status: string) {
  const { data, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
      created_by: adminId,
      pool_type: "WHO_WILL_ADVANCE",
      question: "fixtures-management test pool",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(data.id as string);
  return data.id as string;
}

async function isAvailableForPoolCreation(fixtureId: string): Promise<boolean> {
  const { data } = await admin
    .from("fixtures_available_for_pool_creation")
    .select("id")
    .eq("id", fixtureId)
    .maybeSingle();
  return data != null;
}

describe.skipIf(!SERVICE_ROLE_KEY)("fixture management", () => {
  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      const { error } = await admin.from("pools").delete().in("id", createdPoolIds);
      if (error) throw error;
    }
    if (createdFixtureIds.length > 0) {
      const { error } = await admin.from("fixtures").delete().in("id", createdFixtureIds);
      if (error) throw error;
    }
  });

  it("fixtures_available_for_pool_creation includes a fixture with no pools", async () => {
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(true);
  });

  it("fixtures_available_for_pool_creation includes a fixture with a still-in-flight pool", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "OPEN");

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(true);
  });

  it("fixtures_available_for_pool_creation excludes a fixture once its only pool is SETTLED", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "SETTLED");

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(false);
  });

  it("fixtures_available_for_pool_creation excludes a fixture whose CANCELLED and VOIDED pools are its only ones", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "CANCELLED");
    await createPool(fixtureId, adminId, "VOIDED");

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(false);
  });

  it("fixtures_available_for_pool_creation excludes a fixture manually hidden via hidden_from_pool_creation, even with a still-in-flight pool", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "OPEN");
    expect(await isAvailableForPoolCreation(fixtureId)).toBe(true);

    const { error } = await admin
      .from("fixtures")
      .update({ hidden_from_pool_creation: true })
      .eq("id", fixtureId);
    expect(error).toBeNull();

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(false);

    const { error: unhideError } = await admin
      .from("fixtures")
      .update({ hidden_from_pool_creation: false })
      .eq("id", fixtureId);
    expect(unhideError).toBeNull();

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(true);
  });

  it("fixtures_available_for_pool_creation includes a fixture with one SETTLED and one still-open pool", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "SETTLED");
    await createPool(fixtureId, adminId, "AWAITING_RESULT");

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(true);
  });

  it("fixtures_available_for_pool_creation excludes a COMPLETED fixture with no pools", async () => {
    const fixtureId = await createTestFixture("COMPLETED");
    createdFixtureIds.push(fixtureId);

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(false);
  });

  it("fixtures_available_for_pool_creation excludes a CANCELLED fixture with no pools", async () => {
    const fixtureId = await createTestFixture("CANCELLED");
    createdFixtureIds.push(fixtureId);

    expect(await isAvailableForPoolCreation(fixtureId)).toBe(false);
  });

  it("a fixture with zero pools can be hard-deleted", async () => {
    const fixtureId = await createTestFixture();

    const { error } = await admin.from("fixtures").delete().eq("id", fixtureId);
    expect(error).toBeNull();

    const { data } = await admin.from("fixtures").select("id").eq("id", fixtureId).maybeSingle();
    expect(data).toBeNull();
  });

  it("a fixture with a pool attached cannot be deleted (FK constraint) — the safety net deleteFixtureAction relies on", async () => {
    const adminId = await getAdminId();
    const fixtureId = await createTestFixture();
    createdFixtureIds.push(fixtureId);
    await createPool(fixtureId, adminId, "SETTLED");

    const { error } = await admin.from("fixtures").delete().eq("id", fixtureId);
    expect(error).not.toBeNull();

    const { data } = await admin.from("fixtures").select("id").eq("id", fixtureId).maybeSingle();
    expect(data).not.toBeNull();
  });
});
