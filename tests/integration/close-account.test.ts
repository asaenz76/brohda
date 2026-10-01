/**
 * Integration tests for self-service account closure (self-exclusion
 * compliance). close_own_account() must refuse to run while money could
 * still move for this user (nonzero balance or a pending wallet request),
 * and on success must deactivate the profile and scrub its identifying
 * fields. Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

async function createTestPlayer(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");

  await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: email.split("@")[0],
    avatar_url: "https://example.test/avatars/some-file.webp",
    role: "player",
    is_active: true,
  });

  return data.user.id;
}

function deposit(userId: string, amount: number) {
  return admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: userId,
    p_reason: "integration test",
    p_idempotency_key: randomUUID(),
  });
}

describe.skipIf(!SERVICE_ROLE_KEY)("close_own_account", () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    // wallet_transactions is append-only (no DELETE grant, even for
    // service_role) — any user who received a deposit can never be
    // hard-deleted. Deactivate instead, matching this suite's established
    // pattern.
    await Promise.all(
      createdUserIds.map((id) => admin.from("user_profiles").update({ is_active: false }).eq("id", id)),
    );
  });

  it("refuses to close while the balance is nonzero", async () => {
    const userId = await createTestPlayer(`close-nonzero-${Date.now()}@example.com`);
    createdUserIds.push(userId);
    await deposit(userId, 500);

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error?.message).toContain("nonzero_balance");

    const { data: profile } = await admin
      .from("user_profiles")
      .select("is_active, display_name")
      .eq("id", userId)
      .single();
    expect(profile?.is_active).toBe(true);
  });

  it("refuses to close with a pending wallet request", async () => {
    const userId = await createTestPlayer(`close-pending-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    await admin.from("wallet_requests").insert({
      user_id: userId,
      type: "deposit",
      amount: 1000,
      idempotency_key: randomUUID(),
    });

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error?.message).toContain("pending_wallet_request");
  });

  it("deactivates the profile and scrubs identifying fields on success", async () => {
    const userId = await createTestPlayer(`close-success-${Date.now()}@example.com`);
    createdUserIds.push(userId);

    // bio/pronouns/gender/stories_last_seen_at aren't set by createTestPlayer
    // — set them here so the scrub has something real to null out.
    await admin
      .from("user_profiles")
      .update({ bio: "hi", pronouns: "they/them", gender: "nonbinary", stories_last_seen_at: new Date().toISOString() })
      .eq("id", userId);

    const { error } = await admin.rpc("close_own_account", { p_user_id: userId });
    expect(error).toBeNull();

    const { data: profile } = await admin
      .from("user_profiles")
      .select("is_active, display_name, username, avatar_url, bio, pronouns, gender, stories_last_seen_at")
      .eq("id", userId)
      .single();
    expect(profile).toEqual({
      is_active: false,
      display_name: "Deleted User",
      username: null,
      avatar_url: null,
      bio: null,
      pronouns: null,
      gender: null,
      stories_last_seen_at: null,
    });
  });
});
