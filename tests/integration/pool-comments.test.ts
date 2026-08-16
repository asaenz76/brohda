/**
 * Integration tests for pool comments (Phase 6 of the Instagram-style
 * redesign): add_pool_comment/delete_pool_comment's counter maintenance
 * and ownership check, and RLS isolation on pool_comments. Run with:
 * pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { createCommentReplyNotification } from "@/lib/notifications/create";

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

async function createTestFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `comment-test-${randomUUID()}`,
      home_team_name: "Home Test FC",
      away_team_name: "Away Test FC",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create test fixture");
  return data.id as string;
}

const createdPoolIds: string[] = [];

async function createTestPool(fixtureId: string, adminId: string) {
  const { data: pool, error } = await admin
    .from("pools")
    .insert({
      fixture_id: fixtureId,
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

async function getCommentCount(poolId: string): Promise<number> {
  const { data } = await admin.from("pools").select("comment_count").eq("id", poolId).single();
  return data!.comment_count as number;
}

describe.skipIf(!SERVICE_ROLE_KEY)("pool comments", () => {
  let adminId: string;
  let fixtureId: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    adminId = await getAdminId();
    fixtureId = await createTestFixture();
  });

  afterAll(async () => {
    await Promise.all(createdUserIds.map(deactivate));
    if (createdPoolIds.length > 0) {
      await admin.from("notifications").delete().in("pool_id", createdPoolIds);
      await admin.from("pool_comments").delete().in("pool_id", createdPoolIds);
      await admin.from("pools").delete().in("id", createdPoolIds);
    }
    await admin.from("fixtures").delete().eq("id", fixtureId);
  });

  it("add_pool_comment inserts a row and increments comment_count", async () => {
    const player = await createTestPlayer(`comment-add-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: row, error } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Nice pick!",
    });
    expect(error).toBeNull();
    const comment = Array.isArray(row) ? row[0] : row;
    expect(comment.body).toBe("Nice pick!");
    expect(comment.user_id).toBe(player.userId);
    expect(await getCommentCount(poolId)).toBe(1);
  });

  it("the check constraint rejects an empty or over-length body", async () => {
    const player = await createTestPlayer(`comment-badlen-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { error: emptyError } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "",
    });
    expect(emptyError).not.toBeNull();

    const { error: tooLongError } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "x".repeat(501),
    });
    expect(tooLongError).not.toBeNull();
    expect(await getCommentCount(poolId)).toBe(0);
  });

  it("delete_pool_comment lets the author delete their own comment and decrements the count", async () => {
    const player = await createTestPlayer(`comment-delete-own-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: row } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Delete me",
    });
    const comment = Array.isArray(row) ? row[0] : row;

    const { error } = await admin.rpc("delete_pool_comment", {
      p_comment_id: comment.id,
      p_user_id: player.userId,
    });
    expect(error).toBeNull();
    expect(await getCommentCount(poolId)).toBe(0);
  });

  it("delete_pool_comment rejects a non-owner, non-admin caller", async () => {
    const a = await createTestPlayer(`comment-owner-${Date.now()}@example.com`);
    const b = await createTestPlayer(`comment-intruder-${Date.now()}@example.com`);
    createdUserIds.push(a.userId, b.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: row } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: a.userId,
      p_body: "Only I can delete this",
    });
    const comment = Array.isArray(row) ? row[0] : row;

    const { error } = await admin.rpc("delete_pool_comment", {
      p_comment_id: comment.id,
      p_user_id: b.userId,
    });
    expect(error).not.toBeNull();
    expect(await getCommentCount(poolId)).toBe(1);
  });

  it("delete_pool_comment lets a super admin delete anyone's comment", async () => {
    const player = await createTestPlayer(`comment-admindelete-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: row } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Admin can remove this",
    });
    const comment = Array.isArray(row) ? row[0] : row;

    const { error } = await admin.rpc("delete_pool_comment", {
      p_comment_id: comment.id,
      p_user_id: adminId,
    });
    expect(error).toBeNull();
    expect(await getCommentCount(poolId)).toBe(0);
  });

  it("add_pool_comment accepts a reply to a top-level comment and increments comment_count", async () => {
    const player = await createTestPlayer(`comment-reply-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: parentRow } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Top-level comment",
    });
    const parent = Array.isArray(parentRow) ? parentRow[0] : parentRow;

    const { data: replyRow, error } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "A reply",
      p_parent_comment_id: parent.id,
    });
    expect(error).toBeNull();
    const reply = Array.isArray(replyRow) ? replyRow[0] : replyRow;
    expect(reply.parent_comment_id).toBe(parent.id);
    expect(await getCommentCount(poolId)).toBe(2);
  });

  it("add_pool_comment rejects a reply to a reply (nesting_too_deep)", async () => {
    const player = await createTestPlayer(`comment-nesting-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: parentRow } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Top-level comment",
    });
    const parent = Array.isArray(parentRow) ? parentRow[0] : parentRow;

    const { data: replyRow } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "A reply",
      p_parent_comment_id: parent.id,
    });
    const reply = Array.isArray(replyRow) ? replyRow[0] : replyRow;

    const { error } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "A reply to a reply",
      p_parent_comment_id: reply.id,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("nesting_too_deep");
    expect(await getCommentCount(poolId)).toBe(2);
  });

  it("delete_pool_comment cascades to replies and decrements comment_count by the whole thread", async () => {
    const player = await createTestPlayer(`comment-cascade-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    const { data: parentRow } = await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Top-level comment",
    });
    const parent = Array.isArray(parentRow) ? parentRow[0] : parentRow;

    await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Reply one",
      p_parent_comment_id: parent.id,
    });
    await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Reply two",
      p_parent_comment_id: parent.id,
    });
    expect(await getCommentCount(poolId)).toBe(3);

    const { error } = await admin.rpc("delete_pool_comment", {
      p_comment_id: parent.id,
      p_user_id: player.userId,
    });
    expect(error).toBeNull();
    expect(await getCommentCount(poolId)).toBe(0);

    const { data: remaining } = await admin.from("pool_comments").select("id").eq("pool_id", poolId);
    expect(remaining ?? []).toHaveLength(0);
  });

  it("createCommentReplyNotification notifies the parent comment's author", async () => {
    const author = await createTestPlayer(`comment-notif-author-${Date.now()}@example.com`);
    const replier = await createTestPlayer(`comment-notif-replier-${Date.now()}@example.com`);
    createdUserIds.push(author.userId, replier.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    await createCommentReplyNotification({
      poolId,
      parentCommentUserId: author.userId,
      replierUserId: replier.userId,
      replierDisplayName: "replier",
      replyBody: "Nice pick!",
    });

    const { data: notifications } = await admin
      .from("notifications")
      .select("*")
      .eq("user_id", author.userId)
      .eq("pool_id", poolId);
    expect(notifications).toHaveLength(1);
    expect(notifications![0].type).toBe("COMMENT_REPLY");
    expect(notifications![0].body).toContain("replier");
    expect(notifications![0].body).toContain("Nice pick!");
  });

  it("createCommentReplyNotification skips self-replies", async () => {
    const player = await createTestPlayer(`comment-notif-self-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    await createCommentReplyNotification({
      poolId,
      parentCommentUserId: player.userId,
      replierUserId: player.userId,
      replierDisplayName: "self",
      replyBody: "Replying to myself",
    });

    const { data: notifications } = await admin
      .from("notifications")
      .select("*")
      .eq("user_id", player.userId)
      .eq("pool_id", poolId);
    expect(notifications).toEqual([]);
  });

  it("RLS: authenticated can read comments on a published pool but cannot write the table directly", async () => {
    const player = await createTestPlayer(`comment-rls-${Date.now()}@example.com`);
    createdUserIds.push(player.userId);
    const poolId = await createTestPool(fixtureId, adminId);

    await admin.rpc("add_pool_comment", {
      p_pool_id: poolId,
      p_user_id: player.userId,
      p_body: "Readable via RLS",
    });

    const { data: visible } = await player.client
      .from("pool_comments")
      .select("id, body")
      .eq("pool_id", poolId);
    expect(visible?.length).toBe(1);

    // No INSERT/DELETE grant to authenticated — writes only ever happen
    // through add_pool_comment/delete_pool_comment via the service role.
    const { data: insertData } = await player.client
      .from("pool_comments")
      .insert({ pool_id: poolId, user_id: player.userId, body: "direct insert" })
      .select();
    expect(insertData ?? []).toHaveLength(0);
    expect(await getCommentCount(poolId)).toBe(1);
  });
});
