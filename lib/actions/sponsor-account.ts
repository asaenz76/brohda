"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient as createStatelessClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkLoginRateLimit } from "@/lib/rate-limit/login";
import { checkSponsorResendRateLimit, checkSponsorSignupRateLimit } from "@/lib/rate-limit/sponsor-signup";
import { homePathFor, isSponsorArea } from "@/lib/auth/account-routing";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { CURRENT_SPONSOR_TERMS, SPONSOR_TERMS_KEY } from "@/lib/sponsor/terms";
import { fieldErrorsOf, SPONSOR_NEUTRAL_EMAIL_ERROR, sponsorProfileSchema, sponsorSignupSchema } from "@/lib/sponsor/validation";
import { validateLogo, storeSponsorLogo } from "@/lib/sponsorship/logo-storage";
import { notifySponsorAccount } from "@/lib/sponsorship/notify";
import { loginSchema } from "@/lib/validations/profile";

export type SponsorSignupState = { error: string | null; fieldErrors?: Record<string, string>; sent?: boolean };
export type SponsorLoginState = { error: string | null };
export type SponsorProfileState = { error: string | null; fieldErrors?: Record<string, string>; saved?: boolean };

const GENERIC_SIGNUP_ERROR = "We couldn't create your Sponsor account. Try again in a moment.";

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/** A stateless anon client: signing up must never put a session cookie on this response, and must never be able to succeed "as" someone. */
function statelessAnonClient() {
  return createStatelessClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/**
 * Where the verification link lands. APP_URL is the canonical origin; when it isn't configured (local and CI runs) the request's own origin is used. Either
 * way Supabase Auth only honours a redirect that is on its allow-list, so this can never send a person somewhere arbitrary.
 */
async function verifiedRedirect(): Promise<string> {
  const configured = process.env.APP_URL?.replace(/\/$/, "");
  if (configured) return `${configured}/sponsor/verified`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}/sponsor/verified`;
}

/**
 * Dedicated Sponsor application. NOT part of Member registration and never reachable from it. Creates, in order: an UNVERIFIED login (Supabase sends the
 * verification email — nothing here can mark an email verified), then — atomically in one database function — the SPONSOR account type, the Sponsor
 * organization (PENDING_REVIEW) and the one-to-one link. The database refuses all of it if the email already belongs to a Member, so exclusivity does not
 * depend on this code. Every refusal for "that email is taken" is the same neutral message and never says which kind of account holds it.
 */
export async function sponsorSignupAction(_prev: SponsorSignupState, formData: FormData): Promise<SponsorSignupState> {
  const parsed = sponsorSignupSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    brandName: formData.get("brandName"),
    contactName: formData.get("contactName"),
    website: formData.get("website") || undefined,
    country: formData.get("country") || undefined,
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success) return { error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const input = parsed.data;

  // The acceptance is required only once counsel has approved a document (see lib/sponsor/terms.ts).
  if (CURRENT_SPONSOR_TERMS && formData.get("acceptedTerms") !== "on") return { error: "Check the highlighted fields.", fieldErrors: { acceptedTerms: "Accept the Sponsor Terms to continue." } };

  const logo = formData.get("logo");
  let logoBytes: Uint8Array | null = null;
  if (logo instanceof File && logo.size > 0) {
    const checked = await validateLogo(logo);
    if (!checked.ok) return { error: "Check the highlighted fields.", fieldErrors: { logo: checked.error } };
    logoBytes = checked.bytes;
  }

  if (!(await checkSponsorSignupRateLimit(input.email, await clientIp()))) return { error: "Too many attempts. Please try again in a few minutes." };

  const admin = createAdminClient();
  const { data: existingType } = await admin.rpc("account_type_for_email", { p_email: input.email });
  if (existingType && existingType !== "SPONSOR") return { error: SPONSOR_NEUTRAL_EMAIL_ERROR, fieldErrors: { email: SPONSOR_NEUTRAL_EMAIL_ERROR } };
  const wasNewLogin = !existingType;

  const { data, error } = await statelessAnonClient().auth.signUp({ email: input.email, password: input.password, options: { emailRedirectTo: await verifiedRedirect() } });
  // The email already belongs to a confirmed login: the same neutral message as every other "taken" case, and nothing is created.
  if (error && (error.code === "user_already_exists" || /already (been )?registered/i.test(error.message))) return { error: SPONSOR_NEUTRAL_EMAIL_ERROR, fieldErrors: { email: SPONSOR_NEUTRAL_EMAIL_ERROR } };
  if (error || !data.user) {
    console.error("Sponsor signup: auth signUp failed:", error?.message);
    return { error: GENERIC_SIGNUP_ERROR };
  }
  const user = data.user;

  // FAIL CLOSED: if the project is not requiring email confirmation, signUp hands back a live session. That would be an unverified Sponsor, so the login is
  // removed again and nothing is created.
  if (data.session) {
    console.error("Sponsor signup refused: Supabase email confirmation is OFF. Enable 'Confirm email' in the Auth settings.");
    await admin.auth.admin.deleteUser(user.id);
    return { error: "Sponsor signup is temporarily unavailable. Please try again later." };
  }

  // An already-registered, confirmed email comes back with no identities (Supabase hides that it exists). Neutral message, nothing created.
  if (!user.identities || user.identities.length === 0) return { error: SPONSOR_NEUTRAL_EMAIL_ERROR, fieldErrors: { email: SPONSOR_NEUTRAL_EMAIL_ERROR } };

  const { error: accountError } = await admin.rpc("create_sponsor_account", {
    p_user_id: user.id,
    p_email: input.email,
    p_brand: input.brandName,
    p_contact_name: input.contactName,
    p_website: input.website ?? null,
    p_country: input.country ?? null,
    p_phone: input.phone ?? null,
  });
  if (accountError) {
    console.error("Sponsor signup: create_sponsor_account failed:", accountError.message);
    // Undo a login we just made (it holds the email and has no way in); never delete one that already existed.
    if (wasNewLogin) await admin.auth.admin.deleteUser(user.id);
    const conflict = /member_profile|account_type_conflict|requires_sponsor_type/.test(accountError.message);
    return conflict ? { error: SPONSOR_NEUTRAL_EMAIL_ERROR, fieldErrors: { email: SPONSOR_NEUTRAL_EMAIL_ERROR } } : { error: GENERIC_SIGNUP_ERROR };
  }

  const { data: account } = await admin.from("sponsor_accounts").select("sponsor_id").eq("user_id", user.id).single();
  if (account) {
    if (CURRENT_SPONSOR_TERMS) {
      await admin
        .from("sponsor_terms_acceptances")
        .upsert({ user_id: user.id, sponsor_id: account.sponsor_id, document_key: SPONSOR_TERMS_KEY, version: CURRENT_SPONSOR_TERMS.version, source: "signup" }, { onConflict: "user_id,document_key,version", ignoreDuplicates: true });
    }
    // A logo problem never fails the application — it can be added from the profile page while the application is under review.
    if (logoBytes) await storeSponsorLogo({ id: account.sponsor_id, logo_path: null }, logoBytes);
  }

  return { error: null, sent: true };
}

/** Re-sends the verification email. Always reports success, so it can't be used to find out which emails have a Sponsor application. */
export async function resendSponsorVerificationAction(email: string): Promise<{ sent: true }> {
  const parsed = loginSchema.pick({ email: true }).safeParse({ email });
  if (parsed.success && (await checkSponsorResendRateLimit(parsed.data.email))) {
    const admin = createAdminClient();
    const { data: type } = await admin.rpc("account_type_for_email", { p_email: parsed.data.email });
    if (type === "SPONSOR") await statelessAnonClient().auth.resend({ type: "signup", email: parsed.data.email, options: { emailRedirectTo: await verifiedRedirect() } });
  }
  return { sent: true };
}

export async function sponsorLoginAction(_prev: SponsorLoginState, formData: FormData): Promise<SponsorLoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and password." };
  if (!(await checkLoginRateLimit(parsed.data.email))) return { error: "Too many attempts. Please try again in a few minutes." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  // One message for a wrong password, an unknown email AND an unverified email — it never says which.
  if (error || !data.user) return { error: "Invalid email or password, or your email isn't verified yet." };

  const admin = createAdminClient();
  const { data: typeRow } = await admin.from("account_types").select("account_type").eq("user_id", data.user.id).maybeSingle();
  const accountType = typeRow?.account_type === "MEMBER" || typeRow?.account_type === "SPONSOR" ? typeRow.account_type : null;

  if (accountType === "SPONSOR") await recordFirstVerifiedSignIn(data.user.id);

  const next = sanitizeNextPath(formData.get("next"));
  // A Sponsor only ever returns to a page inside its own area; a Member returns to a Member page. Anything else is the account's home.
  const allowed = next && (accountType === "SPONSOR" ? isSponsorArea(next) : !isSponsorArea(next));
  redirect(allowed ? next : homePathFor(accountType));
}

/** The first time a verified Sponsor signs in: record that the email is verified and the application is now with Brohda, and say so by email (once). */
async function recordFirstVerifiedSignIn(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: account } = await admin.from("sponsor_accounts").select("sponsor_id").eq("user_id", userId).maybeSingle();
    if (!account) return;
    const { data: done } = await admin.from("audit_logs").select("id").eq("entity_type", "sponsor").eq("entity_id", account.sponsor_id).eq("action", "sponsor.email_verified").limit(1);
    if (done && done.length > 0) return;
    await admin.rpc("sponsor_audit", { p_actor: userId, p_action: "sponsor.email_verified", p_sponsor_id: account.sponsor_id, p_before: null, p_after: null, p_reason: null });
    await notifySponsorAccount(account.sponsor_id, "We received your Sponsor application", ["Your email is verified and your application is with Brohda for review.", "You can sign in any time to see where it stands and to finish your profile. You'll get an email when it's decided."]);
  } catch {
    /* never block signing in */
  }
}

/** Edit the Sponsor's own profile. The brand name is editable only while the application is under review (the database enforces it). */
export async function updateSponsorProfileAction(_prev: SponsorProfileState, formData: FormData): Promise<SponsorProfileState> {
  const session = await requireSponsorAccount();
  const parsed = sponsorProfileSchema.safeParse({
    brandName: formData.get("brandName") ?? session.sponsor.displayName,
    contactName: formData.get("contactName"),
    website: formData.get("website") || undefined,
    country: formData.get("country") || undefined,
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success) return { error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };

  const admin = createAdminClient();
  const { error } = await admin.rpc("sponsor_update_profile", {
    p_user_id: session.userId,
    p_fields: {
      display_name: parsed.data.brandName,
      contact_name: parsed.data.contactName,
      website: parsed.data.website ?? "",
      country: parsed.data.country ?? "",
      contact_phone: parsed.data.phone ?? "",
    },
  });
  if (error) {
    if (error.message.includes("identity_change_requires_review")) return { error: "Your brand name is locked after approval. Contact Brohda to change it." };
    if (error.message.includes("sponsor_not_editable")) return { error: "Your account can't be edited right now." };
    return { error: "Could not save your profile. Try again." };
  }
  revalidatePath("/sponsor");
  revalidatePath("/sponsor/profile");
  return { error: null, saved: true };
}

export async function sponsorLogoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/sponsor/login");
}
