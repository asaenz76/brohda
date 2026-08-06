"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireAdminOrAbove } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";
import { createInvitationSchema, acceptInvitationSchema } from "@/lib/validations/invitation";
import { checkInviteLookupRateLimit } from "@/lib/rate-limit/invitations";

export type CreateInvitationState = { error: string | null; inviteUrl: string | null };

export async function createInvitationAction(
  _prevState: CreateInvitationState,
  formData: FormData,
): Promise<CreateInvitationState> {
  const admin = await requireAdminOrAbove();

  const parsed = createInvitationSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: "Enter a valid email.", inviteUrl: null };
  }

  const adminClient = createAdminClient();
  const { data: invitation, error } = await adminClient
    .from("invitations")
    .insert({ email: parsed.data.email, invited_by: admin.id })
    .select("id, token")
    .single();

  if (error || !invitation) {
    return { error: "Could not create invitation.", inviteUrl: null };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "invitation.created",
    entityType: "invitation",
    entityId: invitation.id,
    after: { email: parsed.data.email },
  });

  revalidatePath("/admin/invitations");

  const inviteUrl = `${process.env.APP_URL}/invite/${invitation.token}`;
  return { error: null, inviteUrl };
}

export type RevokeInvitationResult = { success: boolean; error: string | null };

export async function revokeInvitationAction(invitationId: string): Promise<RevokeInvitationResult> {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: before } = await adminClient
    .from("invitations")
    .select("*")
    .eq("id", invitationId)
    .single();

  const { error } = await adminClient
    .from("invitations")
    .update({ status: "revoked" })
    .eq("id", invitationId)
    .eq("status", "pending");

  if (error) {
    return { success: false, error: "Could not revoke invitation." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "invitation.revoked",
    entityType: "invitation",
    entityId: invitationId,
    before,
  });

  revalidatePath("/admin/invitations");
  return { success: true, error: null };
}

export type InvitationLookup =
  | { status: "valid"; email: string }
  | { status: "invalid" | "expired" | "accepted" | "revoked" | "rate_limited" };

export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const allowed = await checkInviteLookupRateLimit(token);
  if (!allowed) {
    return { status: "rate_limited" };
  }

  const adminClient = createAdminClient();
  const { data: invitation } = await adminClient
    .from("invitations")
    .select("email, status, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!invitation) return { status: "invalid" };
  if (invitation.status === "accepted") return { status: "accepted" };
  if (invitation.status === "revoked") return { status: "revoked" };
  if (invitation.status === "expired" || new Date(invitation.expires_at) < new Date()) {
    return { status: "expired" };
  }

  return { status: "valid", email: invitation.email };
}

export type AcceptInvitationState = { error: string | null };

export async function acceptInvitationAction(
  _prevState: AcceptInvitationState,
  formData: FormData,
): Promise<AcceptInvitationState> {
  const parsed = acceptInvitationSchema.safeParse({
    token: formData.get("token"),
    displayName: formData.get("displayName"),
    password: formData.get("password"),
    acceptedRules: formData.get("acceptedRules") === "on",
  });

  if (!parsed.success) {
    return { error: "Please fill in every field and accept the rules." };
  }

  const adminClient = createAdminClient();
  const { data: invitation } = await adminClient
    .from("invitations")
    .select("*")
    .eq("token", parsed.data.token)
    .maybeSingle();

  if (
    !invitation ||
    invitation.status !== "pending" ||
    new Date(invitation.expires_at) < new Date()
  ) {
    return { error: "This invitation is no longer valid." };
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: invitation.email,
    password: parsed.data.password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    return { error: "Could not create your account. Contact your admin." };
  }

  const { error: profileError } = await adminClient.from("user_profiles").insert({
    id: created.user.id,
    display_name: parsed.data.displayName,
    role: "player",
    is_active: true,
    invited_by: invitation.invited_by,
  });

  if (profileError) {
    return { error: "Could not finish setting up your profile. Contact your admin." };
  }

  await adminClient
    .from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invitation.id);

  await writeAuditLog({
    actorId: created.user.id,
    action: "invitation.accepted",
    entityType: "invitation",
    entityId: invitation.id,
  });

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: invitation.email,
    password: parsed.data.password,
  });

  if (signInError) {
    redirect("/login");
  }

  redirect("/feed");
}
