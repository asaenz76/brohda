/**
 * Integration tests for the profile expansion (pronouns/gender/bio, each
 * individually hideable): the column-level grant on user_profiles, and the
 * per-field nulling in public_profiles when a field is hidden.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();

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
    username: email.split("@")[0],
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

const deactivatedIds: string[] = [];

describe("profile fields (pronouns/gender/bio)", () => {
  afterAll(async () => {
    for (const id of deactivatedIds) await deactivate(id);
  });

  it("a player can update their own pronouns/gender/bio and visibility flags", async () => {
    const player = await createTestPlayer(`profile-fields-a-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const { error } = await player.client
      .from("user_profiles")
      .update({
        pronouns: "They/them",
        gender: "Non-binary",
        bio: "Testing PollPools.",
        show_pronouns: true,
        show_gender: false,
        show_bio: true,
      })
      .eq("id", player.userId);

    expect(error).toBeNull();
  });

  it("public_profiles nulls out only the fields the owner hid, per field", async () => {
    const owner = await createTestPlayer(`profile-fields-owner-${Date.now()}@example.com`);
    const viewer = await createTestPlayer(`profile-fields-viewer-${Date.now()}@example.com`);
    deactivatedIds.push(owner.userId, viewer.userId);

    await owner.client
      .from("user_profiles")
      .update({
        pronouns: "She/her",
        gender: "Woman",
        bio: "Hidden bio.",
        show_pronouns: true,
        show_gender: false,
        show_bio: false,
      })
      .eq("id", owner.userId);

    const { data, error } = await viewer.client
      .from("public_profiles")
      .select("pronouns, gender, bio")
      .eq("id", owner.userId)
      .single();

    expect(error).toBeNull();
    expect(data?.pronouns).toBe("She/her");
    expect(data?.gender).toBeNull();
    expect(data?.bio).toBeNull();
  });

  it("a player cannot update another player's profile fields", async () => {
    const playerA = await createTestPlayer(`profile-fields-b-${Date.now()}@example.com`);
    const playerB = await createTestPlayer(`profile-fields-c-${Date.now()}@example.com`);
    deactivatedIds.push(playerA.userId, playerB.userId);

    const { data } = await playerA.client
      .from("user_profiles")
      .update({ bio: "Hijacked." })
      .eq("id", playerB.userId)
      .select();

    // RLS silently returns zero affected rows rather than an error.
    expect(data).toEqual([]);

    const { data: check } = await admin
      .from("user_profiles")
      .select("bio")
      .eq("id", playerB.userId)
      .single();
    expect(check?.bio).not.toBe("Hijacked.");
  });

  it("the bio length check constraint rejects an over-limit value even via the admin client", async () => {
    const player = await createTestPlayer(`profile-fields-d-${Date.now()}@example.com`);
    deactivatedIds.push(player.userId);

    const { error } = await admin
      .from("user_profiles")
      .update({ bio: "a".repeat(151) })
      .eq("id", player.userId);

    expect(error).not.toBeNull();
  });
});
