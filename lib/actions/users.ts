"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSuperAdmin, requireAdminOrAbove } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";
import { setUserRoleSchema, createUserManuallySchema } from "@/lib/validations/users";

// URL-safe, no ambiguous-character trimming needed since this is shown once
// to the admin to copy/share, never typed by hand.
function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}

export type SetUserActiveState = { error: string | null };

export async function setUserActiveAction(
  _prevState: SetUserActiveState,
  formData: FormData,
): Promise<SetUserActiveState> {
  const admin = await requireSuperAdmin();

  const userId = String(formData.get("userId") ?? "");
  const isActive = formData.get("isActive") === "true";
  const reason = String(formData.get("reason") ?? "").trim();

  if (!userId || !reason) {
    return { error: "A reason is required." };
  }

  if (userId === admin.id) {
    return { error: "You cannot change your own active status." };
  }

  const adminClient = createAdminClient();
  const { data: before } = await adminClient
    .from("user_profiles")
    .select("*")
    .eq("id", userId)
    .single();

  const { error } = await adminClient
    .from("user_profiles")
    .update({ is_active: isActive })
    .eq("id", userId);

  if (error) {
    return { error: "Could not update this user." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: isActive ? "user.activated" : "user.deactivated",
    entityType: "user_profile",
    entityId: userId,
    before,
    after: { is_active: isActive },
    reason,
  });

  revalidatePath("/admin/users");
  return { error: null };
}

export type SetUserRoleState = { error: string | null };

// Only ever sets 'player' or 'admin' (validated by setUserRoleSchema) —
// minting/demoting a super_admin stays a manual/create-super-admin-script
// action, never a UI dropdown one click away.
export async function setUserRoleAction(
  _prevState: SetUserRoleState,
  formData: FormData,
): Promise<SetUserRoleState> {
  const admin = await requireSuperAdmin();

  const parsed = setUserRoleSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return { error: "Invalid role." };
  }

  if (parsed.data.userId === admin.id) {
    return { error: "You cannot change your own role." };
  }

  const adminClient = createAdminClient();
  const { data: before } = await adminClient
    .from("user_profiles")
    .select("*")
    .eq("id", parsed.data.userId)
    .single();

  if (!before) {
    return { error: "User not found." };
  }

  if (before.role === "super_admin") {
    return { error: "Super admin roles can't be changed here." };
  }

  const { error } = await adminClient
    .from("user_profiles")
    .update({ role: parsed.data.role })
    .eq("id", parsed.data.userId);

  if (error) {
    return { error: "Could not update this user's role." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "user.role_changed",
    entityType: "user_profile",
    entityId: parsed.data.userId,
    before: { role: before.role },
    after: { role: parsed.data.role },
  });

  revalidatePath("/admin/users");
  return { error: null };
}

export type CreateUserManuallyState = {
  error: string | null;
  credentials: { email: string; password: string } | null;
};

// The invite flow (createInvitationAction) generates a link the admin
// shares and the invitee accepts themselves, choosing their own password.
// This is the direct alternative for when that round-trip isn't practical —
// the account exists immediately, with a random one-time password shown
// here for the admin to hand off out of band. Same requireAdminOrAbove()
// level as invitation creation; always lands as role 'player', same as an
// accepted invitation.
export async function createUserManuallyAction(
  _prevState: CreateUserManuallyState,
  formData: FormData,
): Promise<CreateUserManuallyState> {
  const admin = await requireAdminOrAbove();

  const parsed = createUserManuallySchema.safeParse({
    email: formData.get("email"),
    displayName: formData.get("displayName"),
  });

  if (!parsed.success) {
    return { error: "Enter a valid email and display name.", credentials: null };
  }

  const adminClient = createAdminClient();
  const password = generateTemporaryPassword();

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: parsed.data.email,
    password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    const alreadyExists = createError?.message?.toLowerCase().includes("already");
    return {
      error: alreadyExists ? "A user with this email already exists." : "Could not create this account.",
      credentials: null,
    };
  }

  const { error: profileError } = await adminClient.from("user_profiles").insert({
    id: created.user.id,
    display_name: parsed.data.displayName,
    role: "player",
    is_active: true,
    invited_by: admin.id,
  });

  if (profileError) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return { error: "Could not finish setting up this account.", credentials: null };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "user.created_manually",
    entityType: "user_profile",
    entityId: created.user.id,
    after: { email: parsed.data.email, display_name: parsed.data.displayName },
  });

  revalidatePath("/admin/users");
  return { error: null, credentials: { email: parsed.data.email, password } };
}
