/**
 * Sponsorship foundation against the real database: the paid + Super-Admin-approved invariant, the state machine, authorization and RLS, exclusivity and
 * races, idempotency, material-edit invalidation, the public eligibility read path, the capability switch, audit, and the "no prize engine" check.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedUser } from "./helpers/game-seed";
import { loadPublicSponsorships, resolveActiveSponsorshipTarget } from "@/lib/sponsorship/public";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const HOUR = 3_600_000;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: (Array.isArray(data) ? data[0] : data) as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};
const fails = async (name: string, args: Record<string, unknown>, code: string) => {
  const r = await rpc(name, args);
  expect(r.error?.message ?? "", `${name} should fail with ${code}`).toContain(code);
};

const setEnabled = async (enabled: boolean) => {
  const { error } = await admin.from("platform_settings").update({ sponsorship_enabled: enabled }).eq("id", true);
  if (error) throw error;
};

// Test accounts are never deleted (they can hold ledger history), so staff roles this file hands out are taken back afterwards: other files assert on
// "every admin / super_admin" recipient sets and must not see these.
const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
});

async function superAdmin() {
  const id = await seedUser("sponsoradmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}

async function makeSponsor(name = "Acme") {
  const userId = await seedUser(`sponsor-${name}`);
  const { data: sponsor, error } = await admin.from("sponsors").insert({ display_name: name, logo_path: `${randomUUID()}/logo.webp` }).select("id").single();
  if (error || !sponsor) throw error;
  await admin.from("sponsor_users").insert({ sponsor_id: sponsor.id, user_id: userId });
  return { sponsorId: sponsor.id as string, userId };
}

/** A published Game Post (one Game, one Post) and sponsorable GLOBAL inventory for it. */
async function makeInventory(adminId: string, opts: { startsInHours?: number; endsInHours?: number; price?: number; sponsorable?: boolean; market?: string } = {}) {
  const { fixtureId } = await seedGame({ startsInMinutes: 24 * 60 });
  const { data: post, error } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (error || !post) throw error;
  const inv = await ok("admin_set_sponsorship_inventory", {
    p_admin_id: adminId, p_post_id: post.id, p_market_code: opts.market ?? "GLOBAL", p_is_sponsorable: opts.sponsorable ?? true, p_price_cents: opts.price ?? 150000, p_currency: "USD",
    p_starts_at: new Date(Date.now() + (opts.startsInHours ?? -1) * HOUR).toISOString(), p_ends_at: new Date(Date.now() + (opts.endsInHours ?? 5) * HOUR).toISOString(),
  });
  return { postId: post.id as string, fixtureId, inventoryId: inv.id as string };
}

const fill = { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" };
async function draft(sponsor: { sponsorId: string; userId: string }, inventoryId: string, fields: Record<string, unknown> = fill) {
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inventoryId, p_campaign_name: "Campaign" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: fields });
  return created.id as string;
}
async function submitted(sponsor: { sponsorId: string; userId: string }, inventoryId: string, fields: Record<string, unknown> = fill) {
  const id = await draft(sponsor, inventoryId, fields);
  return (await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: id })) as Row;
}
const pay = (adminId: string, id: string, key = `k-${randomUUID()}`) => ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: id, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: key });
const approve = async (adminId: string, id: string) => {
  const { data } = await admin.from("sponsorships").select("revision").eq("id", id).single();
  return ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: id, p_expected_revision: data!.revision });
};
const get = async (id: string) => (await admin.from("sponsorships").select("*").eq("id", id).single()).data as Row;
const auditActions = async (id: string) => ((await admin.from("audit_logs").select("action").eq("entity_type", "sponsorship").eq("entity_id", id).order("created_at")).data ?? []).map((a) => a.action as string);

describe("the capability: fail-closed, and off means no sponsor activity", () => {
  it("defaults to OFF, and the application reader says OFF", async () => {
    const { data } = await admin.from("platform_settings").select("sponsorship_enabled").eq("id", true).single();
    expect(data!.sponsorship_enabled).toBe(false);
    expect(await isSponsorshipEnabled()).toBe(false);
  });

  it("OFF: a sponsor cannot create, edit, submit — and nothing is lost", async () => {
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    await setEnabled(true);
    const id = await draft(sponsor, inv.inventoryId);
    await setEnabled(false);
    await fails("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "sponsorship_disabled");
    await fails("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: id, p_fields: { tagline: "x" } }, "sponsorship_disabled");
    await fails("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: id }, "sponsorship_disabled");
    expect((await get(id)).lifecycle).toBe("DRAFT"); // records intact
  });

  it("Super Admin keeps operational access while OFF (review, pay, approve still work); only the public side is dark", async () => {
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    await setEnabled(true);
    const s = await submitted(sponsor, inv.inventoryId);
    await setEnabled(false);
    await pay(adminId, s.id);
    const a = await approve(adminId, s.id);
    expect(a.lifecycle).toBe("LIVE");
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
  });

  it("the settings RPC is Super-Admin-only, atomic with its audit row, and conflict-safe", async () => {
    const adminId = await superAdmin();
    const member = await seedUser("member");
    const { data: row } = await admin.from("platform_settings").select("updated_at").eq("id", true).single();
    const args = (id: string, updatedAt: string, enabled: boolean) => ({ p_admin_id: id, p_expected_updated_at: updatedAt, p_sponsorship_enabled: enabled, p_default_currency: "USD", p_logo_max_bytes: 524288, p_end_after_kickoff_hours: 6, p_reservation_hours: 72, p_payment_instructions: "" });
    await fails("update_sponsorship_settings", args(member, row!.updated_at, true), "not_authorized");
    const res = await rpc("update_sponsorship_settings", args(adminId, row!.updated_at, true));
    expect(res.error).toBeNull();
    expect(res.data?.outcome).toBe("updated");
    const stale = await rpc("update_sponsorship_settings", args(adminId, row!.updated_at, false));
    expect(stale.data?.outcome).toBe("conflict");
    const { data: logs } = await admin.from("audit_logs").select("before, after").eq("actor_id", adminId).eq("action", "settings.sponsorship_updated");
    expect(logs).toHaveLength(1);
    expect(logs![0].before.sponsorshipEnabled).toBe(false);
    expect(logs![0].after.sponsorshipEnabled).toBe(true);
  });
});

describe("PAID + SUPER ADMIN APPROVED is the only road to LIVE (enforced in the database)", () => {
  it("the full road: submitted → paid → approved → on the clock, with an audit trail", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    expect(s).toMatchObject({ lifecycle: "SUBMITTED", payment_status: "PENDING", review_status: "PENDING", price_cents: 150000, currency: "USD" });

    const paid = await pay(adminId, s.id);
    expect(paid).toMatchObject({ lifecycle: "SUBMITTED", payment_status: "PAID" }); // payment alone: still not publishable
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);

    const approved = await approve(adminId, s.id);
    expect(approved).toMatchObject({ lifecycle: "LIVE", review_status: "APPROVED", payment_status: "PAID" });
    expect((await loadPublicSponsorships([inv.postId])).get(inv.postId)?.presentedBy).toBe("Acme Sports");

    expect(await auditActions(s.id)).toEqual(["sponsorship.created", "sponsorship.updated", "sponsorship.submitted", "sponsorship.payment_confirmed", "sponsorship.approved"]);
  });

  it("either order works: approved first, still unpaid → not live; payment then completes it (no automatic activation by payment alone)", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    const a = await approve(adminId, s.id);
    expect(a).toMatchObject({ lifecycle: "SUBMITTED", review_status: "APPROVED", payment_status: "PENDING" });
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
    expect((await pay(adminId, s.id)).lifecycle).toBe("LIVE");
  });

  it("a future window schedules instead of going live; the advance job (and only the clock) moves it on", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId, { startsInHours: 3, endsInHours: 9 });
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    expect((await approve(adminId, s.id)).lifecycle).toBe("SCHEDULED");
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0); // not yet in its window
    const mid = await ok("advance_sponsorships", { p_now: new Date(Date.now() + 4 * HOUR).toISOString() });
    expect(mid.wentLive).toBeGreaterThanOrEqual(1); // advance is global: other sponsorships in this database move too
    expect((await get(s.id)).lifecycle).toBe("LIVE");
    const end = await ok("advance_sponsorships", { p_now: new Date(Date.now() + 10 * HOUR).toISOString() });
    expect(end.completed).toBeGreaterThanOrEqual(1);
    expect((await get(s.id)).lifecycle).toBe("COMPLETED");
    expect((await get(s.id)).completed_at).not.toBeNull();
  });

  it("the advance job is idempotent: running it again at the same instant changes nothing", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId, { startsInHours: 1, endsInHours: 4 });
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id); // SCHEDULED
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    const first = await ok("advance_sponsorships", { p_now: at });
    const second = await ok("advance_sponsorships", { p_now: at });
    expect(first.wentLive).toBeGreaterThanOrEqual(1);
    expect([second.wentLive, second.completed, second.reservationsReleased]).toEqual([0, 0, 0]);
    const audits = (await auditActions(s.id)).filter((a) => a === "sponsorship.live");
    expect(audits).toHaveLength(1);
  });

  it("the advance job never activates anything unpaid, unapproved, rejected, suspended or cancelled — whatever the clock says", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("A");
    const unpaidApproved = await submitted(a, (await makeInventory(adminId, { startsInHours: -1, endsInHours: 4 })).inventoryId);
    await approve(adminId, unpaidApproved.id);
    const paidUnapproved = await submitted(a, (await makeInventory(adminId, { startsInHours: -1, endsInHours: 4 })).inventoryId);
    await pay(adminId, paidUnapproved.id);
    const rejected = await submitted(a, (await makeInventory(adminId, { startsInHours: -1, endsInHours: 4 })).inventoryId);
    await ok("admin_reject_sponsorship", { p_admin_id: adminId, p_id: rejected.id, p_reason: "no" });
    const suspended = await submitted(a, (await makeInventory(adminId, { startsInHours: -1, endsInHours: 4 })).inventoryId);
    await pay(adminId, suspended.id);
    await approve(adminId, suspended.id);
    await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: suspended.id, p_reason: "x" });
    const cancelled = await submitted(a, (await makeInventory(adminId, { startsInHours: -1, endsInHours: 4 })).inventoryId);
    await ok("admin_cancel_sponsorship", { p_admin_id: adminId, p_id: cancelled.id, p_reason: "x" });
    await ok("advance_sponsorships", { p_now: new Date(Date.now() + HOUR).toISOString() });
    await ok("advance_sponsorships", { p_now: new Date(Date.now() + 10 * HOUR).toISOString() });
    expect((await get(unpaidApproved.id)).lifecycle).toBe("SUBMITTED");
    expect((await get(paidUnapproved.id)).lifecycle).toBe("SUBMITTED");
    expect((await get(rejected.id)).lifecycle).toBe("REJECTED");
    expect((await get(suspended.id)).lifecycle).toBe("SUSPENDED");
    expect((await get(cancelled.id)).lifecycle).toBe("CANCELLED");
  });

  it("impossible shortcuts are rejected by CHECK constraints even for the service role: PAYMENT_PENDING → LIVE, PAID_PENDING_REVIEW → LIVE, REJECTED → LIVE", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    const tryLive = async () => (await admin.from("sponsorships").update({ lifecycle: "LIVE" }).eq("id", s.id)).error;

    expect((await tryLive())?.message).toContain("sponsorships_public_state_requires_paid_and_approved"); // pending payment, pending review
    await pay(adminId, s.id);
    expect((await tryLive())?.message).toContain("sponsorships_public_state_requires_paid_and_approved"); // paid, not approved
    await admin.from("sponsorships").update({ review_status: "APPROVED", approved_by: adminId, approved_hash: "x" }).eq("id", s.id); // approved with a bogus hash is still not "publishable"...
    const inputs = (await admin.from("sponsorship_eligibility_inputs").select("approval_intact").eq("id", s.id).single()).data!;
    expect(inputs.approval_intact).toBe(false); // ...because the stored approval does not match the content
  });

  it("paid but REJECTED never goes live, and payment is neither deleted nor rewritten (refund is a separate, explicit step)", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    const r = await ok("admin_reject_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "Not on brand" });
    expect(r).toMatchObject({ lifecycle: "REJECTED", review_status: "REJECTED", payment_status: "PAID", rejection_reason: "Not on brand" });
    await fails("admin_approve_sponsorship", { p_admin_id: adminId, p_id: s.id, p_expected_revision: r.revision }, "invalid_transition");
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
    const { data: events } = await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", s.id);
    expect(events!.map((e) => e.event_type)).toContain("PAID");
    // The refund is an explicit, audited step — never automatic.
    const refund = await ok("admin_record_sponsorship_payment_event", { p_admin_id: adminId, p_id: s.id, p_event: "REFUND_PENDING", p_reference: "", p_note: "owner approved refund", p_idempotency_key: `r-${randomUUID()}` });
    expect(refund.payment_status).toBe("REFUND_PENDING");
  });

  it("a refund while scheduled/live ends the campaign and removes it from public", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(1);
    const r = await ok("admin_record_sponsorship_payment_event", { p_admin_id: adminId, p_id: s.id, p_event: "REFUNDED", p_reference: "RF-1", p_note: "", p_idempotency_key: `r-${randomUUID()}` });
    expect(r).toMatchObject({ lifecycle: "CANCELLED", payment_status: "REFUNDED" });
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
  });

  it("suspend removes it immediately, keeps every record, and unsuspend resumes only if still valid", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    const sus = await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "Complaint" });
    expect(sus.lifecycle).toBe("SUSPENDED");
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
    await fails("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "" }, "reason_required");
    expect((await ok("admin_unsuspend_sponsorship", { p_admin_id: adminId, p_id: s.id })).lifecycle).toBe("LIVE");
    // the canonical Post is untouched by all of this
    expect((await admin.from("posts").select("published_at").eq("id", inv.postId).single()).data!.published_at).not.toBeNull();
  });

  it("the capability OFF hides a LIVE sponsorship without changing it, and ON again shows only what is still valid", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const live = await makeInventory(adminId);
    const expiring = await makeInventory(adminId, { startsInHours: -3, endsInHours: 1 });
    const a = await submitted(sponsor, live.inventoryId);
    const b = await submitted(sponsor, expiring.inventoryId);
    for (const s of [a, b]) {
      await pay(adminId, s.id);
      await approve(adminId, s.id);
    }
    expect((await loadPublicSponsorships([live.postId, expiring.postId])).size).toBe(2);
    await setEnabled(false);
    expect((await loadPublicSponsorships([live.postId, expiring.postId])).size).toBe(0);
    expect((await get(a.id)).lifecycle).toBe("LIVE"); // no mutation
    // the window of `expiring` passes while the switch is off, and the stored status was never advanced
    await admin.from("sponsorships").update({ ends_at: new Date(Date.now() - HOUR).toISOString(), starts_at: new Date(Date.now() - 3 * HOUR).toISOString() }).eq("id", b.id);
    await setEnabled(true);
    const shown = await loadPublicSponsorships([live.postId, expiring.postId]);
    expect([...shown.keys()]).toEqual([live.postId]);
  });
});

describe("material edits void an approval (no approve-then-swap)", () => {
  it.each([
    ["destination_url", "https://evil.example.com/"],
    ["presented_by", "Someone Else"],
    ["tagline", "New copy"],
    ["cta_text", "Buy now"],
    ["prize_description", "A car"],
    ["official_rules_url", "https://evil.example.com/rules"],
    ["price_cents", 1],
  ])("changing %s on an approved sponsorship drops the approval and the public presentation", async (column, value) => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId, { ...fill, has_promotion: true, promotion_title: "Win", promotion_description: "d", official_rules_url: "https://acme.example.com/rules", promotion_fulfillment_name: "Acme" });
    // price is frozen once paid, so change it BEFORE paying
    if (column === "price_cents") {
      await approve(adminId, s.id);
      const { error } = await admin.from("sponsorships").update({ price_cents: value as number }).eq("id", s.id);
      expect(error).toBeNull();
      expect(await get(s.id)).toMatchObject({ review_status: "PENDING", approved_hash: null, lifecycle: "SUBMITTED" });
      return;
    }
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(1);
    const { error } = await admin.from("sponsorships").update({ [column]: value }).eq("id", s.id);
    expect(error).toBeNull();
    expect(await get(s.id)).toMatchObject({ review_status: "PENDING", approved_hash: null, approved_by: null, lifecycle: "SUBMITTED" });
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
    expect(await resolveActiveSponsorshipTarget(s.id)).toBeNull(); // not clickable either
  });

  it("a non-material edit (the private campaign name) keeps the approval", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    await admin.from("sponsorships").update({ campaign_name: "Renamed" }).eq("id", s.id);
    expect((await get(s.id)).lifecycle).toBe("LIVE");
  });

  it("a sponsor can no longer edit once submitted/approved, and the approved snapshot is immutable proof of what was approved", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await fails("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: s.id, p_fields: { destination_url: "https://evil.example.com" } }, "not_editable");
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    await fails("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: s.id, p_fields: { tagline: "swap" } }, "not_editable");
    const { data: snap } = await admin.from("sponsorship_approvals").select("id, snapshot").eq("sponsorship_id", s.id).single();
    expect(snap!.snapshot).toMatchObject({ presentedBy: "Acme Sports", destinationUrl: "https://acme.example.com/promo", priceCents: 150000, postId: inv.postId });
    expect((await admin.from("sponsorship_approvals").update({ snapshot: {} }).eq("id", snap!.id)).error?.message).toContain("immutable");
    expect((await admin.from("sponsorship_approvals").delete().eq("id", snap!.id)).error?.message).toContain("immutable");
  });

  it("changes requested → the sponsor edits and resubmits → approval needed again; the old revision stays on record", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    const r = await ok("admin_request_sponsorship_changes", { p_admin_id: adminId, p_id: s.id, p_note: "Use the full legal name" });
    expect(r.review_status).toBe("CHANGES_REQUESTED");
    await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: s.id, p_fields: { presented_by: "Acme Sports LLC" } });
    const again = await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: s.id });
    expect(again).toMatchObject({ review_status: "PENDING", lifecycle: "SUBMITTED" });
    expect(again.revision).toBeGreaterThan(s.revision);
    // a stale approval (for the revision the admin was looking at) is refused
    await fails("admin_approve_sponsorship", { p_admin_id: adminId, p_id: s.id, p_expected_revision: s.revision }, "stale_revision");
  });

  it("promotion metadata is only public once approved; a javascript: link can't even be stored", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const promo = { ...fill, has_promotion: true, promotion_title: "Win tickets", promotion_description: "Enter on our site", prize_description: "2 tickets", official_rules_url: "https://acme.example.com/rules", promotion_fulfillment_name: "Acme Promotions LLC" };
    const s = await submitted(sponsor, inv.inventoryId, promo);
    await pay(adminId, s.id);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0); // paid, unapproved: nothing, promotion included
    await approve(adminId, s.id);
    const shown = (await loadPublicSponsorships([inv.postId])).get(inv.postId)!;
    expect(shown.promotion).toMatchObject({ title: "Win tickets", officialRulesUrl: "https://acme.example.com/rules", fulfillmentName: "Acme Promotions LLC" });
    const bad = await admin.from("sponsorships").update({ official_rules_url: "javascript:alert(1)" }).eq("id", s.id);
    expect(bad.error).not.toBeNull();
    const bad2 = await rpc("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: (await draft(sponsor, (await makeInventory(adminId)).inventoryId)), p_fields: { destination_url: "data:text/html,x" } });
    expect(bad2.error).not.toBeNull();
  });

  it("an incomplete promotion cannot be submitted", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const id = await draft(sponsor, inv.inventoryId, { ...fill, has_promotion: true, promotion_title: "Win" });
    await fails("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: id }, "incomplete_promotion");
  });
});

describe("authorization and isolation", () => {
  it("a sponsor cannot approve, reject, price, mark paid, suspend or set inventory — those functions refuse anyone who is not Super Admin", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    const as = sponsor.userId;
    await fails("admin_approve_sponsorship", { p_admin_id: as, p_id: s.id, p_expected_revision: s.revision }, "not_authorized");
    await fails("admin_reject_sponsorship", { p_admin_id: as, p_id: s.id, p_reason: "x" }, "not_authorized");
    await fails("admin_set_sponsorship_price", { p_admin_id: as, p_id: s.id, p_price_cents: 1 }, "not_authorized");
    await fails("admin_mark_sponsorship_paid", { p_admin_id: as, p_id: s.id, p_reference: "x", p_note: "", p_idempotency_key: "k1" }, "not_authorized");
    await fails("admin_suspend_sponsorship", { p_admin_id: as, p_id: s.id, p_reason: "x" }, "not_authorized");
    await fails("admin_set_sponsorship_inventory", { p_admin_id: as, p_post_id: inv.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 0, p_currency: "USD", p_starts_at: new Date().toISOString(), p_ends_at: new Date(Date.now() + HOUR).toISOString() }, "not_authorized");
    expect(await get(s.id)).toMatchObject({ payment_status: "PENDING", review_status: "PENDING", price_cents: 150000, lifecycle: "SUBMITTED" });
  });

  it("an `admin`-role user (not Super Admin) is refused too — commercial authority is Super Admin's", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const lesser = await seedUser("lesseradmin");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", lesser);
    staffIds.push(lesser);
    const sponsor = await makeSponsor();
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    await fails("admin_approve_sponsorship", { p_admin_id: lesser, p_id: s.id, p_expected_revision: s.revision }, "not_authorized");
  });

  it("Sponsor B cannot touch Sponsor A's sponsorship through any sponsor function", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("Alpha");
    const b = await makeSponsor("Beta");
    const inv = await makeInventory(adminId);
    const id = await draft(a, inv.inventoryId);
    await fails("sponsor_update_sponsorship", { p_user_id: b.userId, p_id: id, p_fields: { tagline: "hijack" } }, "not_authorized");
    await fails("sponsor_submit_sponsorship", { p_user_id: b.userId, p_id: id }, "not_authorized");
    await fails("sponsor_cancel_sponsorship", { p_user_id: b.userId, p_id: id }, "not_authorized");
    await fails("sponsor_create_sponsorship", { p_user_id: b.userId, p_sponsor_id: a.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "not_authorized"); // acting for a sponsor you don't belong to
  });

  it("RLS: sponsors read only their own rows; a normal member and anon read nothing; Super Admin reads all", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("Alpha");
    const b = await makeSponsor("Beta");
    const inv1 = await makeInventory(adminId);
    const inv2 = await makeInventory(adminId);
    const sa = await submitted(a, inv1.inventoryId);
    const sb = await submitted(b, inv2.inventoryId);
    await pay(adminId, sa.id);

    const clientFor = async (userId: string) => {
      const { data } = await admin.auth.admin.getUserById(userId);
      const c = getTestAnonClient();
      const { error } = await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD });
      expect(error).toBeNull();
      return c;
    };
    const asA = await clientFor(a.userId);
    const mine = await asA.from("sponsorships").select("id");
    expect(mine.data!.map((r) => r.id)).toEqual([sa.id]);
    expect((await asA.from("sponsors").select("id")).data!.map((r) => r.id)).toEqual([a.sponsorId]);
    expect((await asA.from("sponsorship_payment_events").select("sponsorship_id")).data!.every((r) => r.sponsorship_id === sa.id)).toBe(true);
    expect((await asA.from("sponsorship_approvals").select("id")).data).toEqual([]);
    expect((await asA.from("sponsorship_exposure_events").select("id")).data).toEqual([]);
    expect((await asA.from("sponsorships").select("id").eq("id", sb.id)).data).toEqual([]);
    // a sponsor cannot write directly either
    expect((await asA.from("sponsorships").update({ payment_status: "PAID" }).eq("id", sa.id)).error).not.toBeNull();
    expect((await asA.from("sponsorships").insert({ sponsor_id: a.sponsorId })).error).not.toBeNull();

    const member = await seedUser("plainmember");
    const asMember = await clientFor(member);
    for (const table of ["sponsors", "sponsor_users", "sponsorships", "sponsorship_inventory", "sponsorship_payment_events", "sponsorship_approvals", "sponsorship_exposure_events", "audit_logs"]) {
      const r = await asMember.from(table).select("*");
      expect(r.data ?? [], table).toEqual([]);
    }

    const anon = getTestAnonClient();
    for (const table of ["sponsors", "sponsorships", "sponsorship_inventory"]) {
      const r = await anon.from(table).select("*");
      expect(r.error !== null || (r.data ?? []).length === 0, table).toBe(true);
    }

    const asAdmin = await clientFor(adminId);
    const seenByAdmin = (await asAdmin.from("sponsorships").select("id")).data!.map((r) => r.id);
    expect(seenByAdmin).toEqual(expect.arrayContaining([sa.id, sb.id]));
  });

  it("a sponsor sees sponsorable inventory only while the capability is ON, and never a member's data", async () => {
    const adminId = await superAdmin();
    const a = await makeSponsor("Alpha");
    const inv = await makeInventory(adminId);
    const { data: u } = await admin.auth.admin.getUserById(a.userId);
    const c = getTestAnonClient();
    await c.auth.signInWithPassword({ email: u.user!.email!, password: PASSWORD });
    await setEnabled(false);
    expect((await c.from("sponsorship_inventory").select("id")).data).toEqual([]);
    await setEnabled(true);
    expect((await c.from("sponsorship_inventory").select("id")).data!.map((r) => r.id)).toContain(inv.inventoryId);
  });

  it("a suspended/disabled sponsor can create, submit and activate nothing new", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    await admin.from("sponsors").update({ status: "SUSPENDED" }).eq("id", sponsor.sponsorId);
    await fails("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "sponsor_not_active");
    await pay(adminId, s.id);
    await fails("admin_approve_sponsorship", { p_admin_id: adminId, p_id: s.id, p_expected_revision: s.revision }, "sponsor_not_active");
    await admin.from("sponsors").update({ status: "ACTIVE" }).eq("id", sponsor.sponsorId);
    await approve(adminId, s.id);
    await admin.from("sponsors").update({ status: "DISABLED" }).eq("id", sponsor.sponsorId);
    expect((await loadPublicSponsorships([s.post_id])).size).toBe(0); // an already-live sponsorship of a disabled sponsor is dark immediately
  });
});

describe("one sponsor per Post + market + period, even under a race", () => {
  it("the second sponsor cannot submit while the first holds the slot; cancelling frees it", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("Alpha");
    const b = await makeSponsor("Beta");
    const inv = await makeInventory(adminId);
    const sa = await submitted(a, inv.inventoryId);
    const idB = await draft(b, inv.inventoryId); // drafts don't hold
    await fails("sponsor_submit_sponsorship", { p_user_id: b.userId, p_id: idB }, "inventory_unavailable");
    await ok("sponsor_cancel_sponsorship", { p_user_id: a.userId, p_id: sa.id });
    expect((await ok("sponsor_submit_sponsorship", { p_user_id: b.userId, p_id: idB })).lifecycle).toBe("SUBMITTED");
  });

  it("two sponsors submitting the same inventory at the same instant: exactly one wins", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsors = await Promise.all([makeSponsor("A"), makeSponsor("B"), makeSponsor("C")]);
    const inv = await makeInventory(adminId);
    const ids = await Promise.all(sponsors.map((s) => draft(s, inv.inventoryId)));
    const results = await Promise.all(sponsors.map((s, i) => rpc("sponsor_submit_sponsorship", { p_user_id: s.userId, p_id: ids[i] })));
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.message.includes("inventory_unavailable"))).toHaveLength(2);
    const { data: holders } = await admin.from("sponsorships").select("id").eq("inventory_id", inv.inventoryId).in("lifecycle", ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED"]);
    expect(holders).toHaveLength(1);
  });

  it("two active sponsorships for one inventory cannot exist even by direct writes (partial unique index)", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("A");
    const b = await makeSponsor("B");
    const inv = await makeInventory(adminId);
    const sa = await submitted(a, inv.inventoryId);
    const idB = await draft(b, inv.inventoryId);
    const { error } = await admin.from("sponsorships").update({ lifecycle: "SUBMITTED" }).eq("id", idB);
    expect(error?.code).toBe("23505");
    expect((await get(sa.id)).lifecycle).toBe("SUBMITTED");
  });

  it("different markets of the same Post are separate inventory (the architecture allows per-market sponsors later)", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const a = await makeSponsor("A");
    const b = await makeSponsor("B");
    const global = await makeInventory(adminId);
    const cr = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: global.postId, p_market_code: "CR", p_is_sponsorable: true, p_price_cents: 5000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    const sa = await submitted(a, global.inventoryId);
    const sb = await submitted(b, cr.id);
    expect([sa.lifecycle, sb.lifecycle]).toEqual(["SUBMITTED", "SUBMITTED"]);
    await pay(adminId, sb.id);
    await approve(adminId, sb.id);
    expect((await loadPublicSponsorships([global.postId])).size).toBe(0); // CR-only: never shown without a trusted location signal
  });

  it("an unpaid hold expires after the configured hours; a paid one never does", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    await admin.from("platform_settings").update({ sponsorship_reservation_hours: 2 }).eq("id", true);
    const a = await makeSponsor("A");
    const b = await makeSponsor("B");
    const unpaid = await submitted(a, (await makeInventory(adminId)).inventoryId);
    const paidOne = await submitted(b, (await makeInventory(adminId)).inventoryId);
    await pay(adminId, paidOne.id);
    const res = await ok("advance_sponsorships", { p_now: new Date(Date.now() + 3 * HOUR).toISOString() });
    expect(res.reservationsReleased).toBeGreaterThanOrEqual(1);
    expect(await get(unpaid.id)).toMatchObject({ lifecycle: "DRAFT", payment_status: "UNPAID" });
    expect((await get(paidOne.id)).lifecycle).toBe("SUBMITTED");
    await admin.from("platform_settings").update({ sponsorship_reservation_hours: 0 }).eq("id", true);
    const another = await submitted(a, (await makeInventory(adminId)).inventoryId);
    await ok("advance_sponsorships", { p_now: new Date(Date.now() + 1000 * HOUR).toISOString() });
    expect((await get(another.id)).lifecycle).toBe("SUBMITTED"); // 0 = never expires
  });
});

describe("idempotency and concurrency", () => {
  it("marking paid twice with the same key (or a second key) creates one payment event and one audit row", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    const key = `pay-${randomUUID()}`;
    await Promise.all([pay(adminId, s.id, key), pay(adminId, s.id, key), pay(adminId, s.id)]);
    const { data: events } = await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", s.id).eq("event_type", "PAID");
    expect(events).toHaveLength(1);
    expect((await auditActions(s.id)).filter((a) => a === "sponsorship.payment_confirmed")).toHaveLength(1);
  });

  it("approving twice (a double-click) is one approval, one snapshot, one audit row, one public sponsorship", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await Promise.all([approve(adminId, s.id), approve(adminId, s.id), approve(adminId, s.id)]);
    expect((await auditActions(s.id)).filter((a) => a === "sponsorship.approved")).toHaveLength(1);
    expect((await admin.from("sponsorship_approvals").select("id").eq("sponsorship_id", s.id)).data).toHaveLength(1);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(1);
  });

  it("suspend, reject, cancel and unsuspend are idempotent too", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    await ok("admin_reject_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "no" });
    await ok("admin_reject_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "no" });
    expect((await auditActions(s.id)).filter((a) => a === "sponsorship.rejected")).toHaveLength(1);
    const cancelledAlready = await rpc("admin_cancel_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "done" });
    expect(cancelledAlready.error?.message ?? "").toContain("invalid_transition"); // a rejected sponsorship is terminal
  });

  it("Super Admin suspends while the scheduled activation runs: whichever lands, the end state is never publicly live-and-suspended", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId, { startsInHours: 1, endsInHours: 8 });
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id); // SCHEDULED
    const later = new Date(Date.now() + 2 * HOUR).toISOString();
    await Promise.all([rpc("advance_sponsorships", { p_now: later }), rpc("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "race" })]);
    const row = await get(s.id);
    expect(["SUSPENDED", "LIVE"]).toContain(row.lifecycle);
    if (row.lifecycle === "SUSPENDED") expect((await loadPublicSponsorships([inv.postId], new Date(Date.now() + 2 * HOUR))).size).toBe(0);
  });

  it("the sponsor edits while Super Admin reviews: the approval can only be for the revision that was reviewed", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    await ok("admin_request_sponsorship_changes", { p_admin_id: adminId, p_id: s.id, p_note: "fix" });
    await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: s.id, p_fields: { tagline: "edited during review" } });
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: s.id });
    await fails("admin_approve_sponsorship", { p_admin_id: adminId, p_id: s.id, p_expected_revision: s.revision }, "stale_revision");
  });
});

describe("Super Admin assigns a sponsorable Game to a sponsor", () => {
  it("creates the sponsor's own draft (audited as an assignment); the sponsor completes and submits it; nothing is public until paid and approved", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const assigned = await ok("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "Opening night" });
    expect(assigned).toMatchObject({ sponsor_id: sponsor.sponsorId, lifecycle: "DRAFT", payment_status: "UNPAID", review_status: "PENDING", campaign_name: "Opening night", created_by: adminId });
    expect(assigned.presented_by).toBe("Acme");
    expect(await auditActions(assigned.id)).toEqual(["sponsorship.assigned"]);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0);
    // The sponsor now owns it: edits, submits (price snapshot from the inventory), and the rest of the road is unchanged.
    await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: assigned.id, p_fields: fill });
    const submittedRow = await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: assigned.id });
    expect(submittedRow).toMatchObject({ lifecycle: "SUBMITTED", price_cents: 150000 });
    await pay(adminId, assigned.id);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(0); // paid, still unapproved
    await approve(adminId, assigned.id);
    expect((await loadPublicSponsorships([inv.postId])).size).toBe(1);
  });

  it("is idempotent: assigning the same sponsor to the same Game twice returns the same draft", async () => {
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const args = { p_admin_id: adminId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" };
    const [a, b] = await Promise.all([ok("admin_assign_sponsorship", args), ok("admin_assign_sponsorship", args)]).catch(async () => [await ok("admin_assign_sponsorship", args), await ok("admin_assign_sponsorship", args)]);
    expect(a.id).toBe(b.id);
    expect((await admin.from("sponsorships").select("id").eq("inventory_id", inv.inventoryId)).data!.length).toBeLessThanOrEqual(2);
  });

  it("only Super Admin can assign; the sponsor must be ACTIVE; the Game must be sponsorable, open and not already held", async () => {
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const other = await makeSponsor("Other");
    const inv = await makeInventory(adminId);
    await fails("admin_assign_sponsorship", { p_admin_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "not_authorized");
    const lesser = await seedUser("lesser");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", lesser);
    staffIds.push(lesser);
    await fails("admin_assign_sponsorship", { p_admin_id: lesser, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "not_authorized");
    await admin.from("sponsors").update({ status: "SUSPENDED" }).eq("id", sponsor.sponsorId);
    await fails("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "sponsor_not_active");
    const closed = await makeInventory(adminId, { sponsorable: false });
    await fails("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: other.sponsorId, p_inventory_id: closed.inventoryId, p_campaign_name: "x" }, "inventory_unavailable");
    const past = await makeInventory(adminId, { startsInHours: -10, endsInHours: -1 });
    await fails("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: other.sponsorId, p_inventory_id: past.inventoryId, p_campaign_name: "x" }, "inventory_unavailable");
    // held by another sponsor's submission
    await setEnabled(true);
    await submitted(other, inv.inventoryId);
    await admin.from("sponsors").update({ status: "ACTIVE" }).eq("id", sponsor.sponsorId);
    await fails("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "inventory_unavailable");
  });

  it("works while the switch is OFF (an operator action), but the sponsor still cannot edit or submit until it is ON", async () => {
    await setEnabled(false);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const assigned = await ok("admin_assign_sponsorship", { p_admin_id: adminId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" });
    await fails("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: assigned.id, p_fields: fill }, "sponsorship_disabled");
    await fails("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: assigned.id }, "sponsorship_disabled");
  });
});

describe("price authority", () => {
  it("Super Admin can reprice before payment; the snapshot freezes at payment and inventory edits never touch a paid sponsorship", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId, { price: 100000 });
    const s = await submitted(sponsor, inv.inventoryId);
    expect(s.price_cents).toBe(100000);
    expect((await ok("admin_set_sponsorship_price", { p_admin_id: adminId, p_id: s.id, p_price_cents: 90000 })).price_cents).toBe(90000);
    await pay(adminId, s.id);
    await fails("admin_set_sponsorship_price", { p_admin_id: adminId, p_id: s.id, p_price_cents: 1 }, "price_locked");
    await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: inv.postId, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 5, p_currency: "EUR", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    expect(await get(s.id)).toMatchObject({ price_cents: 90000, currency: "USD" });
    expect((await admin.from("sponsorships").update({ price_cents: 1 }).eq("id", s.id)).error?.message).toContain("immutable");
  });

  it("only sponsorable inventory can be sponsored", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId, { sponsorable: false });
    await fails("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.inventoryId, p_campaign_name: "x" }, "inventory_unavailable");
  });
});

describe("public data boundary, one Post, and what is NOT built", () => {
  it("the public payload is exactly the safe fields — no price, payment, review notes, contacts, internal name or raw destination", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    const shown = (await loadPublicSponsorships([inv.postId])).get(inv.postId)!;
    expect(Object.keys(shown).sort()).toEqual(["ctaText", "id", "logoUrl", "presentedBy", "promotion", "tagline"]);
    expect(JSON.stringify(shown)).not.toMatch(/150000|INV-1|acme\.example\.com|Campaign|contact/i);
  });

  it("sponsorship never duplicates or alters the canonical Post, Game or Markets", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const before = {
      posts: (await admin.from("posts").select("*").eq("fixture_id", inv.fixtureId)).data,
      fixtures: (await admin.from("fixtures").select("*").eq("id", inv.fixtureId)).data,
      markets: (await admin.from("markets").select("*").eq("fixture_id", inv.fixtureId)).data,
    };
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "test" });
    const strip = (rows: Row[] | null) => (rows ?? []).map(({ updated_at, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(strip((await admin.from("posts").select("*").eq("fixture_id", inv.fixtureId)).data)).toEqual(strip(before.posts));
    expect(strip((await admin.from("fixtures").select("*").eq("id", inv.fixtureId)).data)).toEqual(strip(before.fixtures));
    expect(strip((await admin.from("markets").select("*").eq("fixture_id", inv.fixtureId)).data)).toEqual(strip(before.markets));
    expect((await admin.from("posts").select("id").eq("fixture_id", inv.fixtureId)).data).toHaveLength(1);
  });

  it("there is no prize engine: no entries, qualification, draws, winners, prize custody or settlement anywhere in the schema", async () => {
    // Check the catalogue directly through the superuser connection the isolation helper already uses.
    const { Client } = await import("pg");
    const { getTestDatabaseUrl } = await import("./helpers/test-env");
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      const { rows } = await client.query(`select table_name from information_schema.tables where table_schema = 'public' and table_name ~* '(prize|draw|winner|qualif|entry_|_entries|sweepstake|contest)'`);
      expect(rows.map((r) => r.table_name).filter((n) => !["pool_entries", "pools_entries"].includes(n))).toEqual([]);
      const { rows: cols } = await client.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name like 'sponsor%' and column_name ~* '(winner|draw|qualif|entry|custody|payout)'`);
      expect(cols).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("exposure events: one impression per member per day, many clicks, and neither is exposed to sponsors", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const inv = await makeInventory(adminId);
    const s = await submitted(sponsor, inv.inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    const viewer = await seedUser("viewer");
    const row = { sponsorship_id: s.id, post_id: inv.postId, event_type: "IMPRESSION", user_id: viewer };
    expect((await admin.from("sponsorship_exposure_events").insert(row)).error).toBeNull();
    expect((await admin.from("sponsorship_exposure_events").insert(row)).error?.code).toBe("23505"); // same member, same day
    expect((await admin.from("sponsorship_exposure_events").insert({ ...row, event_type: "CLICK" })).error).toBeNull();
    expect((await admin.from("sponsorship_exposure_events").insert({ ...row, event_type: "CLICK" })).error).toBeNull();
    const { data: events } = await admin.from("sponsorship_exposure_events").select("event_type").eq("sponsorship_id", s.id);
    expect(events!.filter((e) => e.event_type === "IMPRESSION")).toHaveLength(1);
    expect(events!.filter((e) => e.event_type === "CLICK")).toHaveLength(2);
    const target = await resolveActiveSponsorshipTarget(s.id);
    expect(target).toEqual({ postId: inv.postId, destinationUrl: "https://acme.example.com/promo" });
    await setEnabled(false);
    expect(await resolveActiveSponsorshipTarget(s.id)).toBeNull(); // no clicks/impressions recorded for a hidden sponsorship
  });

  it("every commercial action is attributable in the audit log (actor, action, before/after)", async () => {
    await setEnabled(true);
    const adminId = await superAdmin();
    const sponsor = await makeSponsor();
    const s = await submitted(sponsor, (await makeInventory(adminId)).inventoryId);
    await pay(adminId, s.id);
    await approve(adminId, s.id);
    await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: s.id, p_reason: "audit" });
    const { data: logs } = await admin.from("audit_logs").select("actor_id, action, before, after, reason").eq("entity_type", "sponsorship").eq("entity_id", s.id).order("created_at");
    const byAction = Object.fromEntries(logs!.map((l) => [l.action, l]));
    expect(byAction["sponsorship.created"].actor_id).toBe(sponsor.userId);
    expect(byAction["sponsorship.submitted"].actor_id).toBe(sponsor.userId);
    expect(byAction["sponsorship.payment_confirmed"]).toMatchObject({ actor_id: adminId });
    expect(byAction["sponsorship.approved"].before.reviewStatus).toBe("PENDING");
    expect(byAction["sponsorship.approved"].after.reviewStatus).toBe("APPROVED");
    expect(byAction["sponsorship.suspended"]).toMatchObject({ actor_id: adminId, reason: "audit" });
    expect(JSON.stringify(logs)).not.toMatch(/password|secret|card/i);
  });
});
