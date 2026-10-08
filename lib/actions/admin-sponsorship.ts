"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { callSponsorshipFunction } from "@/lib/sponsorship/repository";
import { SponsorshipError } from "@/lib/sponsorship/errors";
import { draftToDbFields, inventorySchema, promotionProblems, sponsorshipDraftSchema, type SponsorshipDraftInput } from "@/lib/sponsorship/validation";
import { notifySponsorMembers } from "@/lib/sponsorship/notify";

// Super Admin sponsorship actions. Every one begins with requireSuperAdmin() (an `admin`-role user is NOT enough: this is commercial authority) and then
// calls a database function that re-checks the actor itself. Approval is an explicit human action here — there is no webhook, payment or schedule path
// that approves.
export type AdminSponsorshipResult = { success: boolean; error: string | null; id?: string; fieldErrors?: Record<string, string> };

const fail = (error: unknown): AdminSponsorshipResult => ({ success: false, error: error instanceof SponsorshipError ? error.message : "Something went wrong. Try again." });

function revalidateAll(id?: string) {
  revalidatePath("/admin/sponsorship");
  revalidatePath("/admin/sponsorship/inventory");
  if (id) revalidatePath(`/admin/sponsorship/${id}`);
  revalidatePath("/feed");
  revalidatePath("/");
}

async function run(id: string, fn: string, args: Record<string, unknown>, notify?: { subject: string; lines: string[] }): Promise<AdminSponsorshipResult> {
  try {
    const row = await callSponsorshipFunction(fn, args);
    if (notify) await notifySponsorMembers(row.sponsor_id, notify.subject, notify.lines);
    revalidateAll(id);
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

const idSchema = z.uuid();
const reasonSchema = z.string().trim().min(1, "A reason is required.").max(1000);

export async function setInventoryAction(raw: unknown): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const parsed = inventorySchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  const v = parsed.data;
  try {
    await callSponsorshipFunction("admin_set_sponsorship_inventory", { p_admin_id: admin.id, p_post_id: v.postId, p_market_code: v.marketCode, p_is_sponsorable: v.isSponsorable, p_price_cents: v.priceCents, p_currency: v.currency, p_starts_at: new Date(v.startsAt).toISOString(), p_ends_at: new Date(v.endsAt).toISOString() });
    revalidateAll();
    return { success: true, error: null };
  } catch (error) {
    return fail(error);
  }
}

export async function setSponsorshipPriceAction(id: string, priceCents: number): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success || !Number.isInteger(priceCents) || priceCents < 0) return { success: false, error: "Enter a valid price." };
  return run(id, "admin_set_sponsorship_price", { p_admin_id: admin.id, p_id: id, p_price_cents: priceCents });
}

/** `idempotencyKey` is generated when the form renders: a double-click or retry sends the same key and changes nothing the second time. */
export async function markSponsorshipPaidAction(id: string, reference: string, note: string, idempotencyKey: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  return run(id, "admin_mark_sponsorship_paid", { p_admin_id: admin.id, p_id: id, p_reference: reference.slice(0, 200), p_note: note.slice(0, 1000), p_idempotency_key: idempotencyKey || `mark-paid:${id}:${randomUUID()}` }, { subject: "Brohda received your payment", lines: ["Payment for your sponsorship was confirmed.", "It still needs Brohda's approval before it can go live."] });
}

export async function recordPaymentEventAction(id: string, event: string, reference: string, note: string, idempotencyKey: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  return run(id, "admin_record_sponsorship_payment_event", { p_admin_id: admin.id, p_id: id, p_event: event, p_reference: reference.slice(0, 200), p_note: note.slice(0, 1000), p_idempotency_key: idempotencyKey || `pay-event:${id}:${randomUUID()}` });
}

export async function approveSponsorshipAction(id: string, expectedRevision: number): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success || !Number.isInteger(expectedRevision)) return { success: false, error: "Sponsorship not found." };
  return run(id, "admin_approve_sponsorship", { p_admin_id: admin.id, p_id: id, p_expected_revision: expectedRevision }, { subject: "Your sponsorship was approved", lines: ["Brohda approved your sponsorship.", "It runs automatically in its scheduled window once payment is confirmed."] });
}

export async function rejectSponsorshipAction(id: string, reason: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const r = reasonSchema.safeParse(reason);
  if (!idSchema.safeParse(id).success || !r.success) return { success: false, error: r.success ? "Sponsorship not found." : r.error.issues[0].message };
  return run(id, "admin_reject_sponsorship", { p_admin_id: admin.id, p_id: id, p_reason: r.data }, { subject: "Your sponsorship was not approved", lines: ["Brohda did not approve your sponsorship.", `Reason: ${r.data}`] });
}

export async function requestSponsorshipChangesAction(id: string, note: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const r = reasonSchema.safeParse(note);
  if (!idSchema.safeParse(id).success || !r.success) return { success: false, error: r.success ? "Sponsorship not found." : r.error.issues[0].message };
  return run(id, "admin_request_sponsorship_changes", { p_admin_id: admin.id, p_id: id, p_note: r.data }, { subject: "Changes requested on your sponsorship", lines: ["Brohda asked for changes before approving your sponsorship.", `Note: ${r.data}`] });
}

export async function suspendSponsorshipAction(id: string, reason: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const r = reasonSchema.safeParse(reason);
  if (!idSchema.safeParse(id).success || !r.success) return { success: false, error: r.success ? "Sponsorship not found." : r.error.issues[0].message };
  return run(id, "admin_suspend_sponsorship", { p_admin_id: admin.id, p_id: id, p_reason: r.data }, { subject: "Your sponsorship was suspended", lines: ["Brohda suspended your sponsorship; it is no longer shown.", `Reason: ${r.data}`] });
}

export async function unsuspendSponsorshipAction(id: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  return run(id, "admin_unsuspend_sponsorship", { p_admin_id: admin.id, p_id: id });
}

export async function cancelSponsorshipByAdminAction(id: string, reason: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const r = reasonSchema.safeParse(reason);
  if (!idSchema.safeParse(id).success || !r.success) return { success: false, error: r.success ? "Sponsorship not found." : r.error.issues[0].message };
  return run(id, "admin_cancel_sponsorship", { p_admin_id: admin.id, p_id: id, p_reason: r.data });
}

// --- sponsors (organizations) ---------------------------------------------------------------------------------------------------------------------

export async function createSponsorAction(raw: { displayName: string; legalName?: string; contactEmail?: string }): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const parsed = z.object({ displayName: z.string().trim().min(1).max(80), legalName: z.string().trim().max(160).optional(), contactEmail: z.string().trim().max(254).optional() }).safeParse(raw);
  if (!parsed.success) return { success: false, error: "Enter the sponsor's display name." };
  const db = createAdminClient();
  const { data, error } = await db.from("sponsors").insert({ display_name: parsed.data.displayName, legal_name: parsed.data.legalName || null, contact_email: parsed.data.contactEmail || null, created_by: admin.id }).select("id").single();
  if (error || !data) return { success: false, error: "Could not create the sponsor." };
  await writeAuditLog({ actorId: admin.id, action: "sponsor.created", entityType: "sponsor", entityId: data.id, after: { displayName: parsed.data.displayName } });
  revalidatePath("/admin/sponsorship/sponsors");
  return { success: true, error: null, id: data.id };
}

export async function setSponsorStatusAction(sponsorId: string, status: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(sponsorId).success || !["ACTIVE", "SUSPENDED", "DISABLED"].includes(status)) return { success: false, error: "Invalid sponsor status." };
  const db = createAdminClient();
  const { data: before } = await db.from("sponsors").select("status").eq("id", sponsorId).maybeSingle();
  if (!before) return { success: false, error: "Sponsor not found." };
  if (before.status === status) return { success: true, error: null, id: sponsorId };
  const { error } = await db.from("sponsors").update({ status }).eq("id", sponsorId);
  if (error) return { success: false, error: "Could not update the sponsor." };
  await writeAuditLog({ actorId: admin.id, action: "sponsor.status_changed", entityType: "sponsor", entityId: sponsorId, before: { status: before.status }, after: { status } });
  revalidatePath("/admin/sponsorship/sponsors");
  return { success: true, error: null, id: sponsorId };
}

/** Links an existing account (by email) to a sponsor as a member. The person then signs in normally and sees /sponsor. */
export async function addSponsorMemberAction(sponsorId: string, email: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  const wanted = email.trim().toLowerCase();
  if (!idSchema.safeParse(sponsorId).success || !z.string().email().safeParse(wanted).success) return { success: false, error: "Enter the member's account email." };
  const db = createAdminClient();
  // Find the auth user by email (paged lookup; sponsor membership is a rare admin action).
  let userId: string | null = null;
  for (let page = 1; page <= 50 && !userId; page++) {
    const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
    userId = data?.users.find((u) => u.email?.toLowerCase() === wanted)?.id ?? null;
    if (!data || data.users.length < 200) break;
  }
  if (!userId) return { success: false, error: "No account with that email. They need to sign up (or be invited) first." };
  const { data: profile } = await db.from("user_profiles").select("id, display_name").eq("id", userId).maybeSingle();
  if (!profile) return { success: false, error: "That account has no Brohda profile yet — they need to finish signing up first." };
  const { data: existing } = await db.from("sponsor_users").select("user_id").eq("sponsor_id", sponsorId).eq("user_id", userId).maybeSingle();
  if (existing) return { success: true, error: null, id: sponsorId };
  const { error } = await db.from("sponsor_users").insert({ sponsor_id: sponsorId, user_id: userId });
  if (error) return { success: false, error: "Could not add the member." };
  await writeAuditLog({ actorId: admin.id, action: "sponsor.member_added", entityType: "sponsor", entityId: sponsorId, after: { userId } });
  revalidatePath("/admin/sponsorship/sponsors");
  return { success: true, error: null, id: sponsorId };
}

export async function removeSponsorMemberAction(sponsorId: string, userId: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(sponsorId).success || !idSchema.safeParse(userId).success) return { success: false, error: "Member not found." };
  const db = createAdminClient();
  const { error } = await db.from("sponsor_users").delete().eq("sponsor_id", sponsorId).eq("user_id", userId);
  if (error) return { success: false, error: "Could not remove the member." };
  await writeAuditLog({ actorId: admin.id, action: "sponsor.member_removed", entityType: "sponsor", entityId: sponsorId, before: { userId } });
  revalidatePath("/admin/sponsorship/sponsors");
  return { success: true, error: null, id: sponsorId };
}

/**
 * Assigns a sponsorable Game to a sponsor: creates the sponsor's DRAFT sponsorship for that inventory (the sponsor then completes and submits it; nothing is
 * public until it is paid and approved). Returns the new sponsorship's id so the admin can open it.
 */
export async function assignSponsorshipAction(sponsorId: string, inventoryId: string, campaignName: string): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(sponsorId).success || !idSchema.safeParse(inventoryId).success) return { success: false, error: "Choose a sponsor." };
  try {
    const row = await callSponsorshipFunction("admin_assign_sponsorship", { p_admin_id: admin.id, p_sponsor_id: sponsorId, p_inventory_id: inventoryId, p_campaign_name: campaignName.trim().slice(0, 120) });
    revalidateAll(row.id);
    revalidatePath("/sponsor");
    return { success: true, error: null, id: row.id };
  } catch (error) {
    return fail(error);
  }
}

// --- complete / submit on behalf of a sponsor --------------------------------------------------------------------------------------------------------

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) out[String(issue.path[0] ?? "form")] = out[String(issue.path[0] ?? "form")] ?? issue.message;
  return out;
}

/** Super Admin edits a sponsorship's content on the sponsor's behalf (only while it is still editable: a draft, or sent back for changes). */
export async function saveSponsorshipAsAdminAction(id: string, raw: unknown): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  return run(id, "admin_update_sponsorship", { p_admin_id: admin.id, p_id: id, p_fields: draftToDbFields(parsed.data) });
}

/**
 * Super Admin saves what is on screen and SUBMITS it on the sponsor's behalf: the price is snapshotted from the inventory, payment becomes PENDING and the Game is held.
 * It does not mark anything paid and does not approve — those are the next, separate steps on the same page.
 */
export async function submitSponsorshipAsAdminAction(id: string, raw: unknown): Promise<AdminSponsorshipResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const problems = promotionProblems(parsed.data as SponsorshipDraftInput);
  if (problems.length > 0) return { success: false, error: problems[0] };
  try {
    await callSponsorshipFunction("admin_update_sponsorship", { p_admin_id: admin.id, p_id: id, p_fields: draftToDbFields(parsed.data) });
    await callSponsorshipFunction("admin_submit_sponsorship", { p_admin_id: admin.id, p_id: id });
    revalidateAll(id);
    revalidatePath("/sponsor");
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}
