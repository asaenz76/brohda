/**
 * Integration tests for the follow graph (Phase 4 of the Instagram-style
 * redesign): unique_follow idempotency, the is_following/get_follow_counts
 * RPCs, and RLS isolation — the follows table itself grants nothing to
 * authenticated, not even SELECT, so all reads go through those RPCs.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { createFollowerEntryNotifications } from "@/lib/notifications/create";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    role: "player",
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

async function deactivate(userId: string) {
  await admin.from("user_profiles").update({ is_active: false }).eq("id", userId);
}

async function follow(followerId: string, followeeId: string) {
  const { error } = await admin.from("follows").insert({ follower_id: followerId, followee_id: followeeId });
  if (error) throw error;
}

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

const createdPoolIds: string[] = [];
const createdFixtureIds: string[] = [];

async function createTestPool(adminId: string): Promise<string> {
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `follows-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create test fixture");
  createdFixtureIds.push(fixture.id as string);

  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixture.id,
      created_by: adminId,
      pool_type: "WHO_WILL_ADVANCE",
      question: "Who will advance?",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 2,
      open_at: new Date().toISOString(),
      locks_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      status: "OPEN",
    })
    .select("id")
    .single();
  if (error || !pool) throw error ?? new Error("failed to create test pool");
  createdPoolIds.push(pool.id as string);
  return pool.id as string;
}

describe.skipIf(!SERVICE_ROLE_KEY)("follows", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    if (createdPoolIds.length > 0) {
      await admin.from("notifications").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    if (createdFixtureIds.length > 0) {
      await admin.from("fixtures").delete().in("id", createdFixtureIds);
    }
    await Promise.all(createdUserIds.map(deactivate));
  });

  it("unique_follow rejects a duplicate follow edge", async () => {
    const a = await createTestPlayer(`follow-dup-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`follow-dup-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);

    await follow(a.userId, b.userId);
    const { error } = await admin.from("follows").insert({ follower_id: a.userId, followee_id: b.userId });
    expect(error?.code).toBe("23505");
  });

  it("the check constraint rejects a self-follow", async () => {
    const a = await createTestPlayer(`follow-self-${Date.now()}@example.com`);
    createdUserIds.push(a.userId);

    const { error } = await admin.from("follows").insert({ follower_id: a.userId, followee_id: a.userId });
    expect(error).not.toBeNull();
  });

  it("get_follow_counts and is_following reflect the underlying rows", async () => {
    const a = await createTestPlayer(`follow-counts-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`follow-counts-b-${Date.now()}@example.com`);
    const c = await createTestPlayer(`follow-counts-c-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId, c.userId);

    await follow(a.userId, c.userId);
    await follow(b.userId, c.userId);
    await follow(c.userId, a.userId);

    const { data: cCounts } = await a.client
      .rpc("get_follow_counts", { p_user_id: c.userId })
      .single();
    expect(cCounts).toEqual({ follower_count: 2, following_count: 1 });

    const { data: aFollowsC } = await a.client.rpc("is_following", {
      p_follower_id: a.userId,
      p_followee_id: c.userId,
    });
    expect(aFollowsC).toBe(true);

    const { data: bFollowsA } = await a.client.rpc("is_following", {
      p_follower_id: b.userId,
      p_followee_id: a.userId,
    });
    expect(bFollowsA).toBe(false);
  });

  it("RLS: authenticated has no direct table access — reads only through the RPCs", async () => {
    const a = await createTestPlayer(`follow-rls-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`follow-rls-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);

    await follow(a.userId, b.userId);

    // No SELECT grant at all — even a's own edge is unreadable directly.
    const { error: selectError, data: selectData } = await a.client
      .from("follows")
      .select("*");
    expect(selectData ?? []).toHaveLength(0);
    void selectError;

    // No INSERT/DELETE grant — a can't follow/unfollow by writing the
    // table directly, only through the service-role-backed server action.
    const { data: insertData } = await a.client
      .from("follows")
      .insert({ follower_id: a.userId, followee_id: b.userId })
      .select();
    expect(insertData ?? []).toHaveLength(0);

    const { data: deleteData } = await a.client
      .from("follows")
      .delete()
      .eq("follower_id", a.userId)
      .eq("followee_id", b.userId)
      .select();
    expect(deleteData ?? []).toHaveLength(0);

    // The edge inserted via the admin client above is untouched.
    const { data: stillThere } = await admin
      .from("follows")
      .select("id")
      .eq("follower_id", a.userId)
      .eq("followee_id", b.userId)
      .single();
    expect(stillThere).not.toBeNull();
  });

  it("get_followers/get_following list the right people and report is_following per row", async () => {
    const a = await createTestPlayer(`follow-list-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`follow-list-b-${Date.now()}@example.com`);
    const c = await createTestPlayer(`follow-list-c-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId, c.userId);

    // b and c both follow a; a follows only c; c also follows b (so the
    // viewer-specific is_following column can differ per row).
    await follow(b.userId, a.userId);
    await follow(c.userId, a.userId);
    await follow(a.userId, c.userId);
    await follow(c.userId, b.userId);

    const { data: aFollowers } = await a.client.rpc("get_followers", {
      p_user_id: a.userId,
      p_viewer_id: a.userId,
    });
    const followerIds = (aFollowers ?? []).map((r: { user_id: string }) => r.user_id).sort();
    expect(followerIds).toEqual([b.userId, c.userId].sort());

    const { data: aFollowing } = await a.client.rpc("get_following", {
      p_user_id: a.userId,
      p_viewer_id: a.userId,
    });
    expect(aFollowing).toEqual([
      expect.objectContaining({ user_id: c.userId, is_following: true }),
    ]);

    // Viewed as b: b doesn't follow c, so c's row in a's follower list
    // should report is_following: false from b's perspective.
    const { data: aFollowersFromB } = await b.client.rpc("get_followers", {
      p_user_id: a.userId,
      p_viewer_id: b.userId,
    });
    const cRow = (aFollowersFromB ?? []).find(
      (r: { user_id: string }) => r.user_id === c.userId,
    );
    expect(cRow).toMatchObject({ is_following: false });
  });

  it("get_followers/get_following exclude deactivated accounts", async () => {
    const a = await createTestPlayer(`follow-inactive-a-${Date.now()}@example.com`);
    const b = await createTestPlayer(`follow-inactive-b-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);

    await follow(b.userId, a.userId);
    await deactivate(b.userId);

    const { data: aFollowers } = await a.client.rpc("get_followers", {
      p_user_id: a.userId,
      p_viewer_id: a.userId,
    });
    expect(aFollowers ?? []).toHaveLength(0);
  });

  it("get_pick_count matches a raw count of the user's entries, regardless of status", async () => {
    const a = await createTestPlayer(`pick-count-new-${Date.now()}@example.com`);
    createdUserIds.push(a.userId);

    const { data: freshCount } = await a.client.rpc("get_pick_count", { p_user_id: a.userId });
    expect(freshCount).toBe(0);

    // Cross-check against a real seeded user with actual entries, rather
    // than fabricating pool/entry rows just for this test.
    const { data: seededUser } = await admin
      .from("entries")
      .select("user_id")
      .limit(1)
      .single();
    if (seededUser) {
      const { count: rawCount } = await admin
        .from("entries")
        .select("id", { count: "exact", head: true })
        .eq("user_id", seededUser.user_id);
      const { data: rpcCount } = await admin.rpc("get_pick_count", {
        p_user_id: seededUser.user_id,
      });
      expect(rpcCount).toBe(rawCount);
    }
  });

  it("createFollowerEntryNotifications notifies every follower when the followed user enters a pool", async () => {
    const adminId = await getAdminId();
    const followee = await createTestPlayer(`follow-notif-followee-${Date.now()}@example.com`);
    const followerA = await createTestPlayer(`follow-notif-a-${Date.now()}@example.com`);
    const followerB = await createTestPlayer(`follow-notif-b-${Date.now()}@example.com`);
    const stranger = await createTestPlayer(`follow-notif-stranger-${Date.now()}@example.com`);
    createdUserIds.push(followee.userId, followerA.userId, followerB.userId, stranger.userId);

    await follow(followerA.userId, followee.userId);
    await follow(followerB.userId, followee.userId);

    const poolId = await createTestPool(adminId);

    await createFollowerEntryNotifications({
      poolId,
      enteredUserId: followee.userId,
      enteredDisplayName: "Followee",
    });

    const { data: notifications } = await admin
      .from("notifications")
      .select("user_id, type, title, body, pool_id")
      .eq("pool_id", poolId);

    const recipientIds = (notifications ?? []).map((n) => n.user_id).sort();
    expect(recipientIds).toEqual([followerA.userId, followerB.userId].sort());
    expect(recipientIds).not.toContain(stranger.userId);
    expect(recipientIds).not.toContain(followee.userId);

    for (const n of notifications ?? []) {
      expect(n.type).toBe("FOLLOWED_USER_ENTERED_POOL");
      expect(n.body).toContain("Followee");
    }
  });

  it("createFollowerEntryNotifications is a no-op when the entering user has no followers", async () => {
    const adminId = await getAdminId();
    const followee = await createTestPlayer(`follow-notif-nofollowers-${Date.now()}@example.com`);
    createdUserIds.push(followee.userId);

    const poolId = await createTestPool(adminId);

    await createFollowerEntryNotifications({
      poolId,
      enteredUserId: followee.userId,
      enteredDisplayName: "Followee",
    });

    const { data: notifications } = await admin.from("notifications").select("id").eq("pool_id", poolId);
    expect(notifications ?? []).toHaveLength(0);
  });
});
