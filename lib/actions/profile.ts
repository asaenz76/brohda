"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { updateProfileSchema, changePasswordSchema } from "@/lib/validations/profile";

export type UpdateProfileState = { error: string | null; success: boolean };

export async function updateProfileAction(
  _prevState: UpdateProfileState,
  formData: FormData,
): Promise<UpdateProfileState> {
  const user = await requireUser();

  const parsed = updateProfileSchema.safeParse({
    displayName: formData.get("displayName"),
    username: formData.get("username") || undefined,
    pronouns: formData.get("pronouns") || undefined,
    gender: formData.get("gender") || undefined,
    bio: formData.get("bio") || undefined,
    showPronouns: formData.get("showPronouns") === "on",
    showGender: formData.get("showGender") === "on",
    showBio: formData.get("showBio") === "on",
  });

  if (!parsed.success) {
    return { error: "Check your profile fields.", success: false };
  }

  // Username is permanent once set — it's what ties a profile to its
  // public URL/mentions/leaderboard row, so letting it change later would
  // silently break every existing link to this person. The form disables
  // the field client-side once set, but that's just UX; this is the real
  // enforcement — whatever was submitted for username is ignored in favor
  // of the existing value, except on the one-time initial set (username
  // still null).
  const nextUsername = user.username ?? parsed.data.username ?? null;

  const supabase = await createClient();
  const { error } = await supabase
    .from("user_profiles")
    .update({
      display_name: parsed.data.displayName,
      username: nextUsername,
      pronouns: parsed.data.pronouns || null,
      gender: parsed.data.gender || null,
      bio: parsed.data.bio || null,
      show_pronouns: parsed.data.showPronouns,
      show_gender: parsed.data.showGender,
      show_bio: parsed.data.showBio,
    })
    .eq("id", user.id);

  if (error) {
    return {
      error: error.code === "23505" ? "That username is taken." : "Could not update profile.",
      success: false,
    };
  }

  revalidatePath("/profile");
  return { error: null, success: true };
}

export type ChangePasswordState = { error: string | null; success: boolean };

export async function changePasswordAction(
  _prevState: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  await requireUser();

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check your password fields.", success: false };
  }

  const supabase = await createClient();

  // supabase.auth.updateUser({password}) only requires an active session —
  // it doesn't itself confirm the caller knows the current password. Verify
  // it explicitly first (e.g. against a shared/left-open device) before
  // allowing the change.
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser?.email) {
    return { error: "Could not verify your account. Please log in again.", success: false };
  }

  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: authUser.email,
    password: parsed.data.currentPassword,
  });
  if (verifyError) {
    return { error: "Current password is incorrect.", success: false };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.newPassword });
  if (error) {
    return { error: "Could not update password. Try again.", success: false };
  }

  return { error: null, success: true };
}
