"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActiveSponsorAccount, requireSponsorAccount } from "@/lib/sponsor/session";
import { callSponsorshipFunction, getSponsorshipForUser } from "@/lib/sponsorship/repository";
import { SponsorshipError } from "@/lib/sponsorship/errors";
import { draftToDbFields, promotionProblems, sponsorshipDraftSchema, type SponsorshipDraftInput } from "@/lib/sponsorship/validation";
import { notifySponsorAccount } from "@/lib/sponsorship/notify";
import { CURRENT_MEDIA_AGREEMENT, CURRENT_SPONSOR_TERMS } from "@/lib/sponsor/terms";
import { evaluateSponsorshipRefundEligibility, getCancellationRecord } from "@/lib/sponsorship/refund-evaluation";

// Sponsor-facing actions. The caller is only ever "a signed-in user": ownership, the Sponsor being ACTIVE and the capability being ON are all re-checked
// inside the database functions, so nothing here can be talked into acting for someone else. There is deliberately NO approve / price / mark-paid /
// activate / schedule action in this file — a sponsor has no path to any of them.
export type SponsorshipActionResult = { success: boolean; error: string | null; fieldErrors?: Record<string, string>; id?: string; refund?: { eligible: boolean; moneyReceived: boolean } };

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
  const session = await requireActiveSponsorAccount();
  const parsed = z.object({ sponsorId: z.uuid(), inventoryId: z.uuid(), campaignName: z.string().trim().min(1).max(120) }).safeParse({ sponsorId, inventoryId, campaignName });
  if (!parsed.success) return { success: false, error: "Give the campaign a name." };
  try {
    const row = await callSponsorshipFunction("sponsor_create_sponsorship", { p_user_id: session.userId, p_sponsor_id: sponsorId, p_inventory_id: inventoryId, p_campaign_name: parsed.data.campaignName });
    revalidateSponsor();
    return { success: true, error: null, id: row.id };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSponsorshipDraftAction(id: string, raw: unknown): Promise<SponsorshipActionResult> {
  const session = await requireActiveSponsorAccount();
  if (!z.uuid().safeParse(id).success) return { success: false, error: "Sponsorship not found." };
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  try {
    await callSponsorshipFunction("sponsor_update_sponsorship", { p_user_id: session.userId, p_id: id, p_fields: draftToDbFields(parsed.data) });
    revalidateSponsor(id);
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

export async function submitSponsorshipAction(id: string, raw: unknown, acceptedAgreement = false): Promise<SponsorshipActionResult> {
  const session = await requireActiveSponsorAccount();
  const parsed = sponsorshipDraftSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const problems = promotionProblems(parsed.data as SponsorshipDraftInput);
  if (problems.length > 0) return { success: false, error: problems[0] };
  // The agreement is only ever required when counsel has APPROVED one (a draft binds nobody). The acceptance is the Sponsor's own explicit act, checked here
  // on the server; the version recorded is this server's current approved version, never anything the browser sent.
  if (CURRENT_MEDIA_AGREEMENT && acceptedAgreement !== true) return { success: false, error: "Accept the Media and Advertising Agreement to submit." };
  try {
    // Save what is on screen first, so what is submitted is exactly what the sponsor sees.
    await callSponsorshipFunction("sponsor_update_sponsorship", { p_user_id: session.userId, p_id: id, p_fields: draftToDbFields(parsed.data) });
    // With an approved agreement, submit and record the acceptance in ONE transaction (the database function adds the record and nothing else).
    const row = CURRENT_MEDIA_AGREEMENT
      ? await callSponsorshipFunction("sponsor_submit_with_agreement", { p_user_id: session.userId, p_id: id, p_agreement_key: CURRENT_MEDIA_AGREEMENT.key, p_agreement_version: CURRENT_MEDIA_AGREEMENT.version, p_terms_key: CURRENT_SPONSOR_TERMS?.key ?? null, p_terms_version: CURRENT_SPONSOR_TERMS?.version ?? null })
      : await callSponsorshipFunction("sponsor_submit_sponsorship", { p_user_id: session.userId, p_id: id });
    await notifySponsorAccount(row.sponsor_id, "We received your sponsorship", ["Your sponsorship was submitted to Brohda for review.", "It goes live only after Brohda confirms payment and approves it."]);
    revalidateSponsor(id);
    revalidatePath("/admin/sponsorship");
    return { success: true, error: null, id };
  } catch (error) {
    return fail(error);
  }
}

/**
 * The Sponsor cancels its own sponsorship. `expectedRefundEligible` is what the Sponsor was TOLD before confirming; if the refund deadline passed while they
 * were reading, nothing is cancelled and they are asked to review the updated notice — they are never surprised after the fact. Eligibility itself is decided
 * and frozen by the database at the moment of cancellation (kickoff and cutoff snapshot); a refund is never executed here.
 */
export async function cancelSponsorshipAction(id: string, expectedRefundEligible?: boolean): Promise<SponsorshipActionResult> {
  const session = await requireActiveSponsorAccount();
  try {
    if (expectedRefundEligible !== undefined) {
      const now = await evaluateSponsorshipRefundEligibility(id, "SPONSOR_CANCELLATION");
      if (now.moneyReceived && now.eligible !== expectedRefundEligible) return { success: false, error: "The refund cancellation deadline changed while you were reviewing this. Please read the updated notice and confirm again." };
    }
    await callSponsorshipFunction("sponsor_cancel_sponsorship", { p_user_id: session.userId, p_id: id });
    revalidateSponsor(id);
    revalidatePath("/admin/sponsorship");
    const record = await getCancellationRecord(id);
    return { success: true, error: null, id, refund: record ? { eligible: record.refundEligible, moneyReceived: record.moneyReceived } : undefined };
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
  const session = await requireSponsorAccount();
  return getSponsorshipForUser(session.userId, id);
}
