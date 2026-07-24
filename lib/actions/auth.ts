"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkLoginRateLimit } from "@/lib/rate-limit/login";
import { checkRegisterRateLimit } from "@/lib/rate-limit/register";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { loginSchema, registerSchema } from "@/lib/validations/profile";

export type LoginState = { error: string | null };

export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  const allowed = await checkLoginRateLimit(parsed.data.email);
  if (!allowed) {
    return { error: "Too many attempts. Please try again in a few minutes." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: "Invalid email or password." };
  }

  redirect("/feed");
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export type RequestPasswordResetState = { sent: boolean; error: string | null };

export async function requestPasswordResetAction(
  _prevState: RequestPasswordResetState,
  formData: FormData,
): Promise<RequestPasswordResetState> {
  const email = String(formData.get("email") ?? "").trim();
  const parsed = loginSchema.pick({ email: true }).safeParse({ email });

  if (!parsed.success) {
    return { sent: false, error: "Enter a valid email." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${process.env.APP_URL}/reset-password`,
  });

  // Always report success to avoid leaking which emails have accounts.
  if (error) {
    console.error("Password reset request failed:", error.message);
  }

  return { sent: true, error: null };
}

export type SetNewPasswordState = { error: string | null };

export async function setNewPasswordAction(
  _prevState: SetNewPasswordState,
  formData: FormData,
): Promise<SetNewPasswordState> {
  const password = String(formData.get("password") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const code = String(formData.get("code") ?? "");
  const supabase = await createClient();

  // Exchanged here, at the point of actual submission, rather than when the
  // page was requested — the code is one-time-use, and exchanging it on
  // page load meant email link-scanners (or any other incidental GET)
  // could burn it before the user's own click ever landed.
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return { error: "This reset link has expired or already been used." };
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { error: "Could not update password. Request a new reset link and try again." };
  }

  redirect("/feed");
}

export type RegisterState = { error: string | null };

/**
 * Self-service signup — off by default (platform_settings.registration_
 * enabled), so re-checked here even though the page itself already hides
 * the form when disabled (a direct POST must not bypass the gate). Mirrors
 * acceptInvitationAction's create-user → insert-profile → sign-in shape,
 * except there's no invitation row and no username collected here — the
 * new account lands on the same forced profile-completion redirect as
 * every other creation path, which is where username actually gets set.
 */
export async function registerAction(
  _prevState: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const enabled = await getRegistrationEnabled();
  if (!enabled) {
    return { error: "Registration is currently closed." };
  }

  const parsed = registerSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
  });

  if (!parsed.success) {
    return { error: "Check your details and try again." };
  }

  const allowed = await checkRegisterRateLimit(parsed.data.email);
  if (!allowed) {
    return { error: "Too many attempts. Please try again in a few minutes." };
  }

  const adminClient = createAdminClient();
  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
  });

  if (createError || !created.user) {
    return {
      error: createError?.message.includes("already been registered")
        ? "An account with this email already exists."
        : "Could not create your account.",
    };
  }

  const { error: profileError } = await adminClient.from("user_profiles").insert({
    id: created.user.id,
    display_name: parsed.data.displayName,
    role: "player",
    is_active: true,
  });

  if (profileError) {
    await adminClient.auth.admin.deleteUser(created.user.id);
    return { error: "Could not finish setting up your account." };
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (signInError) {
    redirect("/login");
  }

  redirect("/profile?tab=edit&required=1");
}
