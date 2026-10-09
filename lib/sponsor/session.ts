import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getAccountContext } from "@/lib/auth/account";
import { MEMBER_HOME, SPONSOR_HOME, sponsorLoginHrefFor } from "@/lib/auth/account-routing";
import { REQUEST_PATH_HEADER, sanitizeNextPath } from "@/lib/auth/safe-next";
import { getSponsorForUser, type SponsorRecord } from "@/lib/sponsorship/repository";

export interface SponsorSession {
  userId: string;
  email: string | null;
  sponsor: SponsorRecord;
}

/** The signed-in SPONSOR account and its organization, or null for anyone else (signed out, a Member, an unclassified login, an unverified email). */
export const getSponsorSession = cache(async (): Promise<SponsorSession | null> => {
  const ctx = await getAccountContext();
  if (!ctx || ctx.accountType !== "SPONSOR" || !ctx.emailVerified) return null;
  const sponsor = await getSponsorForUser(ctx.userId);
  return sponsor ? { userId: ctx.userId, email: ctx.email, sponsor } : null;
});

/**
 * The canonical Sponsor guard: a signed-in SPONSOR account, whatever its review status (pending, rejected and suspended Sponsors can still sign in to
 * see where they stand). A Member is sent to the Member product; a signed-out visitor to the Sponsor login.
 */
export async function requireSponsorAccount(): Promise<SponsorSession> {
  const session = await getSponsorSession();
  if (session) return session;
  const ctx = await getAccountContext();
  if (ctx?.accountType === "MEMBER") redirect(MEMBER_HOME);
  const requested = sanitizeNextPath((await headers()).get(REQUEST_PATH_HEADER));
  redirect(sponsorLoginHrefFor(requested));
}

/** Commercial access: a Sponsor whose account Super Admin has ACTIVATED. Anyone else signed in as a Sponsor goes back to the status page. */
export async function requireActiveSponsorAccount(): Promise<SponsorSession> {
  const session = await requireSponsorAccount();
  if (session.sponsor.status !== "ACTIVE") redirect(SPONSOR_HOME);
  return session;
}
