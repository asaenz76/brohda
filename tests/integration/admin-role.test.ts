/**
 * Integration tests for the distinct, lower-privileged `admin` role: full
 * admin-panel visibility (invitations, user scoping) but no money
 * visibility (wallet_balances/wallet_transactions/wallet_requests for
 * other users stay RLS-blocked).
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestUser(email: string, role: "player" | "admin" | "super_admin") {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role,
    is_active: true,
  });

  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password: "test-password-123",
  });
  if (signInError) throw signInError;

  return { userId: data.user.id as string, client };
}

describe.skipIf(!SERVICE_ROLE_KEY)("admin role", () => {
  let superAdmin: Awaited<ReturnType<typeof createTestUser>>;
  let adminUser: Awaited<ReturnType<typeof createTestUser>>;
  let player: Awaited<ReturnType<typeof createTestUser>>;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    const suffix = Date.now();
    superAdmin = await createTestUser(`admin-role-super-${suffix}@example.com`, "super_admin");
    adminUser = await createTestUser(`admin-role-admin-${suffix}@example.com`, "admin");
    player = await createTestUser(`admin-role-player-${suffix}@example.com`, "player");
    createdUserIds.push(superAdmin.userId, adminUser.userId, player.userId);
  });

  afterAll(async () => {
    await admin.from("invitations").delete().in("invited_by", createdUserIds);
    await Promise.all(
      createdUserIds.map((id) => admin.from("user_profiles").update({ is_active: false }).eq("id", id)),
    );
  });

  it("is_admin_or_above is true and is_super_admin is false for an 'admin' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: adminUser.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: adminUser.userId });
    expect(adminOrAbove).toBe(true);
    expect(superAdminCheck).toBe(false);
  });

  it("is_admin_or_above and is_super_admin are both true for a 'super_admin' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: superAdmin.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: superAdmin.userId });
    expect(adminOrAbove).toBe(true);
    expect(superAdminCheck).toBe(true);
  });

  it("is_admin_or_above and is_super_admin are both false for a 'player' row", async () => {
    const { data: adminOrAbove } = await admin.rpc("is_admin_or_above", { uid: player.userId });
    const { data: superAdminCheck } = await admin.rpc("is_super_admin", { uid: player.userId });
    expect(adminOrAbove).toBe(false);
    expect(superAdminCheck).toBe(false);
  });

  it("lets an admin read the invitations table", async () => {
    await admin.from("invitations").insert({
      email: `invite-target-${Date.now()}@example.com`,
      invited_by: superAdmin.userId,
    });

    const { data, error } = await adminUser.client.from("invitations").select("id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  // Mirrors the exact query app/(admin)/admin/users/page.tsx runs: scoped
  // by .eq("invited_by", viewer.id) for a plain 'admin' viewer, unfiltered
  // for super_admin. select_all_profiles_as_admin (RLS) lets an 'admin'
  // read any profile row, so the scoping has to come from the query itself,
  // not from what RLS blocks — this confirms that query actually narrows
  // the result set rather than relying on RLS to do it.
  it("admin/users scoping: a plain admin only sees users they invited/created, super_admin sees all", async () => {
    const suffix = Date.now();
    const adminA = await createTestUser(`admin-role-scope-a-${suffix}@example.com`, "admin");
    const adminB = await createTestUser(`admin-role-scope-b-${suffix}@example.com`, "admin");
    createdUserIds.push(adminA.userId, adminB.userId);

    const { data: authA } = await admin.auth.admin.createUser({
      email: `admin-role-scope-playera-${suffix}@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
    const { data: authB } = await admin.auth.admin.createUser({
      email: `admin-role-scope-playerb-${suffix}@example.com`,
      password: "test-password-123",
      email_confirm: true,
    });
    const playerAId = authA!.user!.id;
    const playerBId = authB!.user!.id;
    createdUserIds.push(playerAId, playerBId);

    await admin.from("user_profiles").insert([
      {
        id: playerAId,
        display_name: "PlayerOwnedByA",
        role: "player",
        is_active: true,
        invited_by: adminA.userId,
      },
      {
        id: playerBId,
        display_name: "PlayerOwnedByB",
        role: "player",
        is_active: true,
        invited_by: adminB.userId,
      },
    ]);

    const { data: adminAView } = await adminA.client
      .from("user_profiles")
      .select("id")
      .eq("invited_by", adminA.userId)
      .in("id", [playerAId, playerBId]);
    expect((adminAView ?? []).map((u) => u.id)).toEqual([playerAId]);

    const { data: superAdminView } = await superAdmin.client
      .from("user_profiles")
      .select("id")
      .in("id", [playerAId, playerBId]);
    expect((superAdminView ?? []).map((u) => u.id).sort()).toEqual([playerAId, playerBId].sort());
  });

  it("blocks an admin from reading another user's wallet_balances row via RLS", async () => {
    const { data } = await adminUser.client
      .from("wallet_balances")
      .select("balance")
      .eq("user_id", player.userId)
      .maybeSingle();
    expect(data).toBeNull();
  });

  it("blocks an admin from reading another user's wallet_transactions via RLS", async () => {
    const { data } = await adminUser.client
      .from("wallet_transactions")
      .select("id")
      .eq("user_id", player.userId);
    expect(data).toEqual([]);
  });

  it("blocks an admin from reading another user's wallet_requests via RLS", async () => {
    await admin.from("wallet_requests").insert({
      user_id: player.userId,
      type: "deposit",
      amount: 500,
    });

    const { data } = await adminUser.client
      .from("wallet_requests")
      .select("id")
      .eq("user_id", player.userId);
    expect(data).toEqual([]);
  });
});
