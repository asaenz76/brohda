"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkLoginRateLimit } from "@/lib/rate-limit/login";
import { checkRegisterRateLimit } from "@/lib/rate-limit/register";
import { clientNetworkIdentity } from "@/lib/rate-limit/key";
import { loginHrefFor, sanitizeNextPath } from "@/lib/auth/safe-next";
import { recordLegalAcceptance } from "@/lib/legal/acceptance";
import { isSponsorArea, SPONSOR_HOME } from "@/lib/auth/account-routing";
import { typeAccountAsMember } from "@/lib/auth/member-account";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { loginSchema, registerFieldErrors, registerSchema, type RegisterField } from "@/lib/validations/profile";

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
  const { data: signedIn, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: "Invalid email or password." };
  }

  // One login page for everyone: a Sponsor who signs in here lands in the Sponsor area, never in the Member product.
  const { data: typeRow } = await createAdminClient().from("account_types").select("account_type").eq("user_id", signedIn.user.id).maybeSingle();
  if (typeRow?.account_type === "SPONSOR") redirect(SPONSOR_HOME);

  // Back to the page they were sent from — only ever a safe internal path outside the Sponsor area; anything else (or nothing) means /feed.
  const next = sanitizeNextPath(formData.get("next"));
  redirect(next && !isSponsorArea(next) ? next : "/feed");
}

export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // "/" itself decides where a logged-out visitor lands (the marketing
  // landing page when self-service registration is open, /login when it
  // isn't) — logout shouldn't hardcode /login and skip that.
  redirect("/");
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

export type RegisterState = {
  /** A problem that belongs to no single field (rate limit, a failed setup step, registration closed). */
  error: string | null;
  /** What is wrong with each field, in the field's own words — the form shows each next to its field and keeps everything the person typed. */
  fieldErrors?: Partial<Record<RegisterField, string>>;
  /** The email already belongs to an account: the form offers the way to log in (carrying the Game the visitor came for). */
  existingAccount?: boolean;
};

/** Best-effort undo of a half-made account; a failure is logged (user id only — never an email or a password) so an orphan can be found and removed. */
async function discardAccount(adminClient: ReturnType<typeof createAdminClient>, userId: string, profileWritten: boolean) {
  if (profileWritten) {
    const { error } = await adminClient.from("user_profiles").delete().eq("id", userId);
    if (error) console.error("[register] could not remove a half-made profile:", userId, error.message);
  }
  const { error } = await adminClient.auth.admin.deleteUser(userId);
  if (error) console.error("[register] could not remove a half-made account:", userId, error.message);
}

/**
 * Anybody holding the public anon key can create a login for ANY email address straight through the Auth API. It stays unconfirmed (it can't sign in), but it holds the address — Member sign-up then fails with "already
 * registered" — and carries a password the squatter chose. Such an orphan (never confirmed, never signed in, no account type, no profile, and at least ten minutes old so a Sponsor application mid-verification is never touched)
 * is replaced; anything that has ever been used is left alone.
 */
async function reclaimOrphanLogin(adminClient: ReturnType<typeof createAdminClient>, email: string): Promise<boolean> {
  const { data: orphanId } = await adminClient.rpc("reclaimable_orphan_auth_user", { p_email: email });
  if (!orphanId) return false;
  const { error } = await adminClient.auth.admin.deleteUser(orphanId);
  if (error) {
    console.error("[register] could not replace an unused unconfirmed login:", orphanId, error.message);
    return false;
  }
  console.warn("[register] replaced an unused unconfirmed login:", orphanId);
  return true;
}

/**
 * Self-service signup — off by default (platform_settings.registration_
 * enabled), so re-checked here even though the page itself already hides
 * the form when disabled (a direct POST must not bypass the gate). Mirrors
 * acceptInvitationAction's create-user → insert-profile → sign-in shape.
 * ONE submission creates the whole account: email + password (the login), username (set atomically on the profile insert and permanent,
 * see updateProfileAction) and the Terms. There is no name field — display_name starts as the username and is editable in Profile.
 * The username is checked BEFORE the login is created, so the common failure (a taken handle) never creates and deletes an auth user;
 * the unique index still decides a race, and any later failure removes what was made, so no half-made account is left behind.
 */
export async function registerAction(
  _prevState: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const enabled = await getRegistrationEnabled();
  if (!enabled) {
    return { error: "Registration is currently closed." };
  }

  const input = {
    email: formData.get("email"),
    password: formData.get("password"),
    username: formData.get("username"),
    acceptedTerms: formData.get("acceptedTerms") === "on",
  };
  const parsed = registerSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors = registerFieldErrors(input);
    return Object.keys(fieldErrors).length > 0 ? { error: null, fieldErrors } : { error: "Check your details and try again." };
  }

  const limit = await checkRegisterRateLimit(parsed.data.email, clientNetworkIdentity(await headers()));
  if (limit === "limited") {
    return { error: "Too many attempts. Please try again in a few minutes." };
  }
  // The check itself could not be made: sign-up is refused for a moment instead of becoming unlimited.
  if (limit === "unavailable") {
    return { error: "We couldn't check this right now. Please try again in a minute." };
  }

  const adminClient = createAdminClient();

  // Usernames are public (profile links), so telling the person one is taken reveals nothing; checking first spares the login a create-then-delete round trip.
  const [{ data: taken, error: takenError }, { data: reserved, error: reservedError }] = await Promise.all([
    adminClient.from("user_profiles").select("id").eq("username", parsed.data.username).maybeSingle(),
    adminClient.from("reserved_usernames").select("username").eq("username", parsed.data.username).maybeSingle(),
  ]);
  if (takenError || reservedError) {
    console.error("[register] username check failed:", (takenError ?? reservedError)?.message);
    return { error: "Could not create your account. Try again." };
  }
  if (taken) {
    return { error: null, fieldErrors: { username: "That username is taken. Try another." } };
  }
  // Handles that could pass for the platform or its staff (the database refuses them too; this saves creating and removing a login).
  if (reserved) {
    return { error: null, fieldErrors: { username: "That username isn't available. Try another." } };
  }

  const createLogin = () => adminClient.auth.admin.createUser({ email: parsed.data.email, password: parsed.data.password, email_confirm: true });
  let { data: created, error: createError } = await createLogin();
  if (createError?.message.includes("already been registered") && (await reclaimOrphanLogin(adminClient, parsed.data.email))) {
    ({ data: created, error: createError } = await createLogin());
  }

  if (createError || !created.user) {
    // Unchanged policy: the same sentence as before for an email that already has an account (no new account-enumeration signal).
    return createError?.message.includes("already been registered")
      ? { error: null, fieldErrors: { email: "An account with this email already exists." }, existingAccount: true }
      : { error: "Could not create your account." };
  }

  // Explicitly a MEMBER account, before its profile exists (idempotent; the database also refuses a profile for anything that isn't a Member).
  try {
    await typeAccountAsMember(adminClient, created.user.id);
  } catch {
    await discardAccount(adminClient, created.user.id, false);
    return { error: "Could not finish setting up your account." };
  }

  const { error: profileError } = await adminClient.from("user_profiles").insert({
    id: created.user.id,
    display_name: parsed.data.username,
    username: parsed.data.username,
    role: "player",
    is_active: true,
  });

  if (profileError) {
    await discardAccount(adminClient, created.user.id, false);
    if (profileError.code === "23505") return { error: null, fieldErrors: { username: "That username is taken. Try another." } };
    if (profileError.message.includes("reserved_username")) return { error: null, fieldErrors: { username: "That username isn't available. Try another." } };
    return { error: "Could not finish setting up your account." };
  }

  // What they agreed to, and when: a durable record of the CURRENT Terms and Privacy versions. If it can't be written, the account isn't kept
  // — an account whose consent can't be shown is worse than a failed sign-up the person can simply retry.
  try {
    await recordLegalAcceptance(created.user.id, "register");
  } catch {
    await discardAccount(adminClient, created.user.id, true);
    return { error: "Could not finish setting up your account." };
  }

  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (signInError) {
    redirect(loginHrefFor(formData.get("next")));
  }

  redirect(sanitizeNextPath(formData.get("next")) ?? "/feed");
}
