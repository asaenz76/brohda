import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sponsorLogoPublicUrl } from "./logo";
import { toSponsorshipError } from "./errors";
import type { SponsorshipLifecycle, SponsorshipPaymentStatus, SponsorshipReviewStatus, SponsorStatus } from "./types";

// Reads and commands for the sponsorship domain. Everything goes through the service-role client from server code that has ALREADY authorized the
// caller; the database functions re-check actor, ownership, capability and state themselves (defense in depth), so a bug up here cannot publish,
// price or approve anything.

export interface GameSummary {
  homeTeamName: string;
  awayTeamName: string;
  sport: string;
  competitionName: string | null;
  scheduledStartUtc: string;
  internalStatus: string;
}

export interface SponsorRecord {
  id: string;
  displayName: string;
  legalName: string | null;
  contactEmail: string | null;
  logoPath: string | null;
  logoUrl: string | null;
  website: string | null;
  country: string | null;
  contactName: string | null;
  contactPhone: string | null;
  status: SponsorStatus;
  /** Why the account is not ACTIVE — written for the sponsor to read. */
  statusReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface SponsorshipRecord {
  id: string;
  sponsorId: string;
  sponsorName: string | null;
  inventoryId: string;
  postId: string;
  fixtureId: string;
  marketCode: string;
  campaignName: string;
  presentedBy: string | null;
  tagline: string | null;
  ctaText: string | null;
  destinationUrl: string | null;
  logoUrl: string | null;
  hasPromotion: boolean;
  promotionTitle: string | null;
  promotionDescription: string | null;
  prizeDescription: string | null;
  officialRulesUrl: string | null;
  promotionDestinationUrl: string | null;
  promotionFulfillmentName: string | null;
  promotionEligibilitySummary: string | null;
  promotionStartsAt: string | null;
  promotionEndsAt: string | null;
  priceCents: number | null;
  currency: string | null;
  startsAt: string;
  endsAt: string;
  lifecycle: SponsorshipLifecycle;
  reviewStatus: SponsorshipReviewStatus;
  paymentStatus: SponsorshipPaymentStatus;
  revision: number;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  reviewNote: string | null;
  suspensionReason: string | null;
  cancellationReason: string | null;
  createdAt: string;
  game: GameSummary | null;
}

export interface InventoryRecord {
  id: string;
  postId: string;
  fixtureId: string;
  marketCode: string;
  isSponsorable: boolean;
  priceCents: number;
  currency: string;
  startsAt: string;
  endsAt: string;
  game: GameSummary | null;
  /** The sponsorship currently holding this slot (if any) — status only, never who, for sponsors. */
  holdingSponsorshipId: string | null;
  holdingLifecycle: SponsorshipLifecycle | null;
  holdingSponsorName: string | null;
  holdingPaymentStatus: SponsorshipPaymentStatus | null;
  holdingReviewStatus: SponsorshipReviewStatus | null;
}

const HOLDING: SponsorshipLifecycle[] = ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED"];

const GAME_SELECT = "fixtures(home_team_name, away_team_name, sport, competition_name, scheduled_start_utc, internal_status)";

/* eslint-disable @typescript-eslint/no-explicit-any */
function toGame(row: any): GameSummary | null {
  const f = Array.isArray(row?.fixtures) ? row.fixtures[0] : row?.fixtures;
  if (!f) return null;
  return {
    homeTeamName: f.home_team_name,
    awayTeamName: f.away_team_name,
    sport: f.sport,
    competitionName: f.competition_name ?? null,
    scheduledStartUtc: f.scheduled_start_utc,
    internalStatus: f.internal_status,
  };
}

function toSponsor(row: any): SponsorRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    legalName: row.legal_name ?? null,
    contactEmail: row.contact_email ?? null,
    logoPath: row.logo_path ?? null,
    logoUrl: sponsorLogoPublicUrl(row.logo_path),
    website: row.website ?? null,
    country: row.country ?? null,
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    status: row.status,
    statusReason: row.status_reason ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
  };
}

function toSponsorship(row: any): SponsorshipRecord {
  const sponsor = Array.isArray(row.sponsors) ? row.sponsors[0] : row.sponsors;
  return {
    id: row.id,
    sponsorId: row.sponsor_id,
    sponsorName: sponsor?.display_name ?? null,
    inventoryId: row.inventory_id,
    postId: row.post_id,
    fixtureId: row.fixture_id,
    marketCode: row.market_code,
    campaignName: row.campaign_name,
    presentedBy: row.presented_by ?? null,
    tagline: row.tagline ?? null,
    ctaText: row.cta_text ?? null,
    destinationUrl: row.destination_url ?? null,
    logoUrl: sponsorLogoPublicUrl(row.logo_path),
    hasPromotion: row.has_promotion,
    promotionTitle: row.promotion_title ?? null,
    promotionDescription: row.promotion_description ?? null,
    prizeDescription: row.prize_description ?? null,
    officialRulesUrl: row.official_rules_url ?? null,
    promotionDestinationUrl: row.promotion_destination_url ?? null,
    promotionFulfillmentName: row.promotion_fulfillment_name ?? null,
    promotionEligibilitySummary: row.promotion_eligibility_summary ?? null,
    promotionStartsAt: row.promotion_starts_at ?? null,
    promotionEndsAt: row.promotion_ends_at ?? null,
    priceCents: row.price_cents ?? null,
    currency: row.currency ?? null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    lifecycle: row.lifecycle,
    reviewStatus: row.review_status,
    paymentStatus: row.payment_status,
    revision: row.revision,
    submittedAt: row.submitted_at ?? null,
    approvedAt: row.approved_at ?? null,
    rejectionReason: row.rejection_reason ?? null,
    reviewNote: row.review_note ?? null,
    suspensionReason: row.suspension_reason ?? null,
    cancellationReason: row.cancellation_reason ?? null,
    createdAt: row.created_at,
    game: toGame(row),
  };
}

const SPONSORSHIP_SELECT = `*, sponsors(display_name), ${GAME_SELECT}`;

// --- sponsor side -------------------------------------------------------------------------------------------------------------------------------

/** The one Sponsor organization a SPONSOR login owns (one account <-> one organization), or null for any other login. */
export async function getSponsorForUser(userId: string): Promise<SponsorRecord | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsor_accounts").select("sponsors(*)").eq("user_id", userId).maybeSingle();
  const row = Array.isArray(data?.sponsors) ? data?.sponsors[0] : data?.sponsors;
  return row ? toSponsor(row) : null;
}

export async function listSponsorshipsForSponsor(sponsorId: string): Promise<SponsorshipRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("sponsorships").select(SPONSORSHIP_SELECT).eq("sponsor_id", sponsorId).order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(toSponsorship);
}

/** A sponsorship, only if the user belongs to its sponsor. Null otherwise — a sponsor cannot tell "someone else's" from "doesn't exist". */
export async function getSponsorshipForUser(userId: string, id: string): Promise<SponsorshipRecord | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsorships").select(SPONSORSHIP_SELECT).eq("id", id).maybeSingle();
  if (!data) return null;
  const { data: account } = await admin.from("sponsor_accounts").select("user_id").eq("sponsor_id", data.sponsor_id).eq("user_id", userId).maybeSingle();
  return account ? toSponsorship(data) : null;
}

export async function getPaymentEventsForSponsorship(sponsorshipId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("sponsorship_payment_events")
    .select("event_type, amount_cents, currency, provider, provider_reference, note, created_at")
    .eq("sponsorship_id", sponsorshipId)
    .order("created_at");
  return (data ?? []).map((e: any) => ({ eventType: e.event_type as string, amountCents: e.amount_cents as number | null, currency: e.currency as string | null, provider: e.provider as string, providerReference: e.provider_reference as string | null, note: e.note as string | null, createdAt: e.created_at as string }));
}

async function attachHolders(rows: any[]): Promise<InventoryRecord[]> {
  const admin = createAdminClient();
  const ids = rows.map((r) => r.id as string);
  const holders = new Map<string, any>();
  if (ids.length > 0) {
    const { data } = await admin.from("sponsorships").select("id, inventory_id, lifecycle, payment_status, review_status, sponsors(display_name)").in("inventory_id", ids).in("lifecycle", HOLDING);
    for (const h of data ?? []) holders.set(h.inventory_id, h);
  }
  return rows.map((r) => {
    const h = holders.get(r.id);
    const sponsor = Array.isArray(h?.sponsors) ? h.sponsors[0] : h?.sponsors;
    return {
      id: r.id,
      postId: r.post_id,
      fixtureId: r.fixture_id,
      marketCode: r.market_code,
      isSponsorable: r.is_sponsorable,
      priceCents: r.price_cents,
      currency: r.currency,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      game: toGame(r),
      holdingSponsorshipId: h?.id ?? null,
      holdingLifecycle: h?.lifecycle ?? null,
      holdingSponsorName: sponsor?.display_name ?? null,
      holdingPaymentStatus: h?.payment_status ?? null,
      holdingReviewStatus: h?.review_status ?? null,
    };
  });
}

/** Sponsorable, still-open inventory, soonest first. Availability = nothing holds it. */
export async function listAvailableInventory(now: Date = new Date()): Promise<InventoryRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("sponsorship_inventory")
    .select(`*, ${GAME_SELECT}`)
    .eq("is_sponsorable", true)
    .gt("ends_at", now.toISOString())
    .order("starts_at")
    .limit(200);
  if (error) throw error;
  return (await attachHolders(data ?? [])).filter((i) => i.holdingSponsorshipId === null);
}

export async function getInventoryItem(id: string): Promise<InventoryRecord | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsorship_inventory").select(`*, ${GAME_SELECT}`).eq("id", id).maybeSingle();
  if (!data) return null;
  return (await attachHolders([data]))[0];
}

// --- Super Admin side ---------------------------------------------------------------------------------------------------------------------------

export async function listAllInventory(limit = 200): Promise<InventoryRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("sponsorship_inventory").select(`*, ${GAME_SELECT}`).order("starts_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return attachHolders(data ?? []);
}

export async function listAllSponsorships(filter: { lifecycle?: SponsorshipLifecycle[] } = {}, limit = 300): Promise<SponsorshipRecord[]> {
  const admin = createAdminClient();
  let query = admin.from("sponsorships").select(SPONSORSHIP_SELECT).order("created_at", { ascending: false }).limit(limit);
  if (filter.lifecycle?.length) query = query.in("lifecycle", filter.lifecycle);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(toSponsorship);
}

export async function getSponsorshipForAdmin(id: string): Promise<SponsorshipRecord | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsorships").select(SPONSORSHIP_SELECT).eq("id", id).maybeSingle();
  return data ? toSponsorship(data) : null;
}

/** The login behind a Sponsor organization, for Super Admin only. */
export interface SponsorLogin {
  userId: string;
  email: string | null;
  emailVerified: boolean;
}

export interface AdminSponsorRecord extends SponsorRecord {
  /** Super Admin's private note — never sent to the sponsor. */
  internalReviewNote: string | null;
  /** null for an organization that has no login (e.g. one Super Admin recorded by hand). */
  login: SponsorLogin | null;
}

/** Sponsors with their one login (sign-in email, verified or not) so Super Admin can review applications — never shown to anyone else. */
export async function listSponsors(): Promise<AdminSponsorRecord[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsors").select("*, sponsor_accounts(user_id)").order("created_at", { ascending: false });
  const rows = (data ?? []) as any[];
  const logins = new Map<string, SponsorLogin>();
  await Promise.all(
    rows.map(async (r) => {
      const account = Array.isArray(r.sponsor_accounts) ? r.sponsor_accounts[0] : r.sponsor_accounts;
      if (!account) return;
      const { data: u } = await admin.auth.admin.getUserById(account.user_id);
      logins.set(r.id, { userId: account.user_id, email: u.user?.email ?? null, emailVerified: Boolean(u.user?.email_confirmed_at) });
    }),
  );
  return rows.map((r) => ({ ...toSponsor(r), internalReviewNote: r.internal_review_note ?? null, login: logins.get(r.id) ?? null }));
}

export async function listSponsorshipAudit(sponsorshipId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("audit_logs")
    .select("action, created_at, reason, before, after, actor_account_id, actor:user_profiles(display_name)")
    .eq("entity_type", "sponsorship")
    .eq("entity_id", sponsorshipId)
    .order("created_at");
  return (data ?? []).map((a: any) => ({ action: a.action as string, createdAt: a.created_at as string, reason: a.reason as string | null, before: a.before, after: a.after, actorName: ((Array.isArray(a.actor) ? a.actor[0] : a.actor)?.display_name as string | null) ?? (a.actor_account_id ? "Sponsor" : null) }));
}

export interface AgreementAcceptance {
  acceptedAt: string;
  agreementKey: string;
  agreementVersion: string;
  termsVersion: string | null;
  revision: number;
  priceCents: number | null;
  currency: string | null;
  paymentStatus: string;
}

/** The recorded acceptances of the campaign's media agreement, oldest first. Callers authorize first (the owning Sponsor, or Super Admin). */
export async function listAgreementAcceptances(sponsorshipId: string): Promise<AgreementAcceptance[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("sponsorship_agreement_acceptances")
    .select("accepted_at, agreement_key, agreement_version, terms_version, revision, price_cents, currency, payment_status")
    .eq("sponsorship_id", sponsorshipId)
    .order("accepted_at");
  return (data ?? []).map((a: any) => ({ acceptedAt: a.accepted_at, agreementKey: a.agreement_key, agreementVersion: a.agreement_version, termsVersion: a.terms_version, revision: a.revision, priceCents: a.price_cents, currency: a.currency, paymentStatus: a.payment_status }));
}

export async function listApprovalSnapshots(sponsorshipId: string) {
  const admin = createAdminClient();
  const { data } = await admin.from("sponsorship_approvals").select("revision, content_hash, snapshot, approved_at").eq("sponsorship_id", sponsorshipId).order("revision");
  return (data ?? []) as Array<{ revision: number; content_hash: string; snapshot: Record<string, unknown>; approved_at: string }>;
}

// --- commands (thin wrappers over the security-definer functions) --------------------------------------------------------------------------------

export async function callSponsorshipFunction(name: string, args: Record<string, unknown>): Promise<any> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(name, args);
  if (error) throw toSponsorshipError(error);
  return Array.isArray(data) ? data[0] : data;
}
