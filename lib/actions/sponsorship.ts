"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { callSponsorshipFunction, getSponsorshipForUser } from "@/lib/sponsorship/repository";
import { SponsorshipError } from "@/lib/sponsorship/errors";
import { draftToDbFields, promotionProblems, sponsorshipDraftSchema, type SponsorshipDraftInput } from "@/lib/sponsorship/validation";
import { notifySponsorMembers } from "@/lib/sponsorship/notify";

// Sponsor-facing actions. The caller is only ever "a signed-in user": ownership, the Sponsor being ACTIVE and the capability being ON are all re-checked
// inside the database functions, so nothing here can be talked into acting for someone else. There is deliberately NO approve / price / mark-paid /
// activate / schedule action in this file — a sponsor has no path to any of them.
export type SponsorshipActionResult = { success: boolean; error: string | null; fieldErrors?: Record<string, string>; id?: string };

function fail(error: unknown): SponsorshipActionResult {
  return { success: false, error: error instanceof SponsorshipError ? error.message : "Something went wrong. Try again." };
}

function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) fieldErrors[String(issue.path[0] ?? "form")] = fieldErrors[String(issue.path[0] ?? "form")] ?? issue.message;
  return fieldErrors;
}

function revalidateSponsor(id?: string) {
  revalidatePath("/sponsor");
  revalidatePath("/sponsor/games");
  if (id) revalidatePath(`/sponsor/${id}`);
}

export async function createSponsorshipAction(sponsorId: string, inventoryId: string, campaignName: string): Promise<SponsorshipActionResult> {
  const user = await requireUser();
  const parsed = z.object({ sponsorId: z.uuid(), inventoryId: z.uuid(), campaignName: z.string().trim().min(1).max(120) }).safeParse({ sponsorId, inventoryId, campaignName });
  if (!parsed.success) return { success: false, error: "Give the campaign a name." };
  try {
    const row = await callSponsorshipFunction("sponsor_create_sponsorship", { p_user_id: user.id, p_sponsor_id: sponsorId, p_inventory_id: inventoryId, p_campaign_name: parsed.data.campaignName });
    revalidateSponsor();
    return { success: true, error: null, id: row.id };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSponsorshipDraftAction(id: string, raw: unknown): Promise<SponsorshipActionResult> {
  const user = await requireUser();
  if (!z.uuid().safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  try {
    await callSponsorshipFunction("sponsor_update_sponsorship", { p_user_id: user.id, p_id: id, p_fields: draftToDbFields(parsed.data) });
    revalidateSponsor(id);
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

export async function submitSponsorshipAction(id: string, raw: unknown): Promise<SponsorshipActionResult> {
  const user = await requireUser();
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const problems = promotionProblems(parsed.data as SponsorshipDraftInput);
  if (problems.length > 0) return { success: false, error: problems[0] };
  try {
    // Save what is on screen first, so what is submitted is exactly what the sponsor sees.
    await callSponsorshipFunction("sponsor_update_sponsorship", { p_user_id: user.id, p_id: id, p_fields: draftToDbFields(parsed.data) });
    const row = await callSponsorshipFunction("sponsor_submit_sponsorship", { p_user_id: user.id, p_id: id });
    await notifySponsorMembers(row.sponsor_id, "We received your sponsorship", ["Your sponsorship was submitted to Brohda for review.", "It goes live only after Brohda confirms payment and approves it."]);
    revalidateSponsor(id);
    revalidatePath("/admin/sponsorship");
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelSponsorshipAction(id: string): Promise<SponsorshipActionResult> {
  const user = await requireUser();
  try {
    await callSponsorshipFunction("sponsor_cancel_sponsorship", { p_user_id: user.id, p_id: id });
    revalidateSponsor(id);
    revalidatePath("/admin/sponsorship");
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

/** Creates a draft and goes to its editor. */
export async function startSponsorshipAction(formData: FormData): Promise<void> {
  const result = await createSponsorshipAction(String(formData.get("sponsorId") ?? ""), String(formData.get("inventoryId") ?? ""), String(formData.get("campaignName") ?? ""));
  if (!result.success || !result.id) redirect(`/sponsor/games?error=${encodeURIComponent(result.error ?? "Could not start the sponsorship.")}`);
  redirect(`/sponsor/${result.id}`);
}

export async function loadOwnSponsorship(id: string) {
  const user = await requireUser();
  return getSponsorshipForUser(user.id, id);
}
