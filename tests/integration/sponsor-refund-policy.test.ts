/**
 * The Sponsor refund policy (V1) against the real database: ONE eligibility decision from the canonical Game start and ONE configurable cutoff, exact
 * boundaries with server-controlled time, the Sponsor's cutoff never applied to Brohda-caused cancellations, a frozen decision snapshot per cancellation,
 * the slot released independently of refund eligibility, history kept, and eligibility never becoming a refund.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";

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
const staffIds: string[] = [];
// Tests in this file change the cutoff; every test starts from the schema default.
beforeEach(async () => {
  await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 12 }).eq("id", true);
});
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false, sponsorship_refund_cutoff_hours: 12 }).eq("id", true);
});
async function superAdmin() {
  const id = await seedUser("refundadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}

/** A sponsorship whose Game kicks off exactly `kickoffInHours` from now. `paid`: submitted, paid and approved (SCHEDULED/LIVE). */
async function campaign(opts: { kickoffInHours: number; paid?: boolean; submit?: boolean }) {
  const adminId = await superAdmin();
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
  const sponsor = await seedSponsorAccount("refund");
  const { fixtureId } = await seedGame({ startsInMinutes: Math.round(opts.kickoffInHours * 60) });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 50000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + (opts.kickoffInHours + 6) * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Refund" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  if (opts.submit !== false) await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  if (opts.paid) {
    await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: created.id, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: randomUUID() });
    const { data } = await admin.from("sponsorships").select("revision").eq("id", created.id).single();
    await ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: created.id, p_expected_revision: data!.revision });
  }
  return { adminId, sponsor, sponsorshipId: created.id as string, inventoryId: inv.id as string, postId: post!.id as string, fixtureId };
}
const kickoffOf = async (fixtureId: string) => new Date((await admin.from("fixtures").select("scheduled_start_utc").eq("id", fixtureId).single()).data!.scheduled_start_utc as string);
const evaluate = async (id: string, reason: string, now: Date) => ok("sponsorship_refund_evaluation", { p_id: id, p_reason: reason, p_now: now.toISOString() }) as Promise<Row>;
const payment = async (id: string) => (await admin.from("sponsorships").select("payment_status, lifecycle").eq("id", id).single()).data!;

describe("the 12-hour rule, exactly (server-controlled time, no sleeping)", () => {
  it("measures from the canonical Game start: T-12h-1s eligible, exactly T-12h eligible, T-11h59m59s not, after kickoff not", async () => {
    const c = await campaign({ kickoffInHours: 48, paid: true });
    const kickoff = await kickoffOf(c.fixtureId);
    const at = (ms: number) => new Date(kickoff.getTime() + ms);
    const before = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at(-12 * HOUR - 1000));
    const exactly = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at(-12 * HOUR));
    const inside = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at(-12 * HOUR + 1000));
    const after = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at(60_000));
    expect([before.eligible, exactly.eligible, inside.eligible, after.eligible]).toEqual([true, true, false, false]);
    expect(before.reasonCode).toBe("SPONSOR_CANCELLED_BEFORE_CUTOFF");
    expect(inside.reasonCode).toBe("SPONSOR_CANCELLED_INSIDE_CUTOFF");
    // The cutoff it reports is kickoff minus the configured hours, from the Game — not the sponsorship's creation, payment or approval time.
    expect(new Date(before.cutoffAt).getTime()).toBe(kickoff.getTime() - 12 * HOUR);
    expect(new Date(before.kickoffAt).getTime()).toBe(kickoff.getTime());
    expect(before.cutoffHours).toBe(12);
  });

  it("the cutoff is ONE configurable value, not a number scattered through the code", async () => {
    const c = await campaign({ kickoffInHours: 48, paid: true });
    const kickoff = await kickoffOf(c.fixtureId);
    const at8h = new Date(kickoff.getTime() - 8 * HOUR);
    expect((await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at8h)).eligible).toBe(false); // default 12
    await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 6 }).eq("id", true);
    const six = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", at8h);
    expect(six.eligible).toBe(true);
    expect(six.cutoffHours).toBe(6);
    expect((await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: -1 }).eq("id", true)).error).not.toBeNull(); // bounded
  });
});

describe("the other refund cases (the Sponsor's cutoff never applies where Brohda cannot or will not deliver)", () => {
  it("each cause, evaluated at T-1h (deep inside the cutoff)", async () => {
    const c = await campaign({ kickoffInHours: 48, paid: true });
    const now = new Date((await kickoffOf(c.fixtureId)).getTime() - HOUR);
    const e = (reason: string) => evaluate(c.sponsorshipId, reason, now);
    expect(await e("SPONSOR_CANCELLATION")).toMatchObject({ eligible: false });
    expect(await e("BROHDA_REJECTED")).toMatchObject({ eligible: true, reasonCode: "BROHDA_REJECTED", requiresChoice: false });
    const brohda = await e("BROHDA_CANCELLED_NO_BREACH");
    expect(brohda).toMatchObject({ eligible: true, requiresChoice: true });
    expect(brohda.options).toEqual(["FULL_REFUND", "REPLACEMENT_INVENTORY"]); // never forced onto replacement inventory — the Sponsor chooses
    const game = await e("GAME_UNDELIVERABLE");
    expect(game).toMatchObject({ eligible: true, requiresChoice: true });
    expect(game.options).toEqual(expect.arrayContaining(["FULL_REFUND", "REPLACEMENT_GAME", "PRESERVE_OR_RESCHEDULE"]));
    expect(await e("SPONSOR_BREACH")).toMatchObject({ eligible: false, reasonCode: "SPONSOR_BREACH_NO_AUTOMATIC_REFUND" });
    expect(await e("BROHDA_LIVE_INTERRUPTION")).toMatchObject({ eligible: true, requiresChoice: true });
    expect(await e("COMPLETED_DELIVERED")).toMatchObject({ eligible: false, reasonCode: "COMPLETED_DELIVERED" });
    expect(await e("BROHDA_NON_DELIVERY")).toMatchObject({ eligible: true });
    const bad = await rpc("sponsorship_refund_evaluation", { p_id: c.sponsorshipId, p_reason: "WHATEVER", p_now: now.toISOString() });
    expect(bad.error?.message ?? "").toContain("invalid_reason");
  });

  it("an unpaid sponsorship reports that no money was received (nothing to refund)", async () => {
    const c = await campaign({ kickoffInHours: 48 });
    const e = await evaluate(c.sponsorshipId, "SPONSOR_CANCELLATION", new Date());
    expect(e.moneyReceived).toBe(false);
  });

  it("the evaluation is server-only", async () => {
    const c = await campaign({ kickoffInHours: 48, paid: true });
    expect((await getTestAnonClient().rpc("sponsorship_refund_evaluation", { p_id: c.sponsorshipId, p_reason: "SPONSOR_CANCELLATION" })).error).not.toBeNull();
  });
});

describe("a Sponsor cancelling a PAID sponsorship: frozen decision, slot released, money untouched", () => {
  it("T-24h: refund-eligible; the snapshot freezes kickoff, cutoff and result; payment stays PAID; the slot is free for another Sponsor; history stays", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    const kickoff = await kickoffOf(c.fixtureId);
    const cancelled = await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    expect(cancelled.lifecycle).toBe("CANCELLED");
    expect(cancelled.payment_status).toBe("PAID"); // eligibility is not a refund
    const { data: snap } = await admin.from("sponsorship_cancellations").select("*").eq("sponsorship_id", c.sponsorshipId).single();
    expect(snap).toMatchObject({ initiator: "SPONSOR", cancelled_by: c.sponsor.userId, refund_eligible: true, money_received: true, reason_code: "SPONSOR_CANCELLED_BEFORE_CUTOFF", cutoff_hours: 12, payment_status: "PAID", sponsor_id: c.sponsor.sponsorId });
    expect(new Date(snap!.kickoff_at).getTime()).toBe(kickoff.getTime());
    expect(new Date(snap!.cutoff_at).getTime()).toBe(kickoff.getTime() - 12 * HOUR);
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", c.sponsorshipId).in("event_type", ["REFUND_PENDING", "REFUNDED"])).data).toEqual([]);
    // Audit: the cancellation and the decision, separately from any later refund.
    const { data: logs } = await admin.from("audit_logs").select("action, actor_account_id").eq("entity_id", c.sponsorshipId);
    expect(logs!.map((l) => l.action)).toEqual(expect.arrayContaining(["sponsorship.cancelled", "sponsorship.refund_eligibility_decided"]));
    expect(logs!.find((l) => l.action === "sponsorship.refund_eligibility_decided")!.actor_account_id).toBe(c.sponsor.userId);

    // The slot is available again: a different Sponsor can take the same inventory; the cancelled record, its payment and its audit are untouched.
    const other = await seedSponsorAccount("buyer");
    const next = await ok("sponsor_create_sponsorship", { p_user_id: other.userId, p_sponsor_id: other.sponsorId, p_inventory_id: c.inventoryId, p_campaign_name: "Next" });
    expect(next.id).not.toBe(c.sponsorshipId);
    await ok("sponsor_update_sponsorship", { p_user_id: other.userId, p_id: next.id, p_fields: { presented_by: "Next Co", tagline: "x", cta_text: "Go", destination_url: "https://next.example.com" } });
    expect((await ok("sponsor_submit_sponsorship", { p_user_id: other.userId, p_id: next.id })).lifecycle).toBe("SUBMITTED");
    const holders = (await admin.from("sponsorships").select("id").eq("inventory_id", c.inventoryId).in("lifecycle", ["SUBMITTED", "SCHEDULED", "LIVE", "SUSPENDED"])).data!;
    expect(holders.map((h) => h.id)).toEqual([next.id]); // no double-active sponsorship
    expect((await admin.from("sponsorships").select("lifecycle, payment_status").eq("id", c.sponsorshipId).single()).data).toEqual({ lifecycle: "CANCELLED", payment_status: "PAID" });
    expect((await admin.from("sponsorship_payment_events").select("id").eq("sponsorship_id", c.sponsorshipId)).data!.length).toBeGreaterThan(0);
  });

  it("T-6h: NOT refund-eligible — the Sponsor may still cancel and the slot is still released", async () => {
    const c = await campaign({ kickoffInHours: 6, paid: true });
    const cancelled = await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    expect(cancelled).toMatchObject({ lifecycle: "CANCELLED", payment_status: "PAID" });
    const { data: snap } = await admin.from("sponsorship_cancellations").select("refund_eligible, reason_code").eq("sponsorship_id", c.sponsorshipId).single();
    expect(snap).toEqual({ refund_eligible: false, reason_code: "SPONSOR_CANCELLED_INSIDE_CUTOFF" });
    const other = await seedSponsorAccount("buyer2");
    expect((await ok("sponsor_create_sponsorship", { p_user_id: other.userId, p_sponsor_id: other.sponsorId, p_inventory_id: c.inventoryId, p_campaign_name: "Next" })).lifecycle).toBe("DRAFT");
  });

  it("cancelling before approval is covered by the same rule (approval status does not matter)", async () => {
    const c = await campaign({ kickoffInHours: 24 }); // submitted, never approved
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV-2", p_note: "paid", p_idempotency_key: randomUUID() });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    expect((await admin.from("sponsorship_cancellations").select("refund_eligible, review_status").eq("sponsorship_id", c.sponsorshipId).single()).data).toEqual({ refund_eligible: true, review_status: "PENDING" });
  });

  it("the decision is FROZEN: a later reschedule or a changed cutoff never rewrites it", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    const before = (await admin.from("sponsorship_cancellations").select("*").eq("sponsorship_id", c.sponsorshipId).single()).data!;
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + HOUR).toISOString() }).eq("id", c.fixtureId); // the Game is moved to T-1h
    await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 48 }).eq("id", true);
    const after = (await admin.from("sponsorship_cancellations").select("*").eq("sponsorship_id", c.sponsorshipId).single()).data!;
    expect(after).toEqual(before);
    expect(after.refund_eligible).toBe(true);
    // ...while a fresh evaluation reflects the new facts.
    expect((await ok("sponsorship_refund_evaluation", { p_id: c.sponsorshipId, p_reason: "SPONSOR_CANCELLATION", p_now: new Date().toISOString() })).eligible).toBe(false);
    expect((await admin.from("sponsorship_cancellations").update({ refund_eligible: false }).eq("sponsorship_id", c.sponsorshipId)).error?.message ?? "").toContain("immutable");
    expect((await admin.from("sponsorship_cancellations").delete().eq("sponsorship_id", c.sponsorshipId)).error?.message ?? "").toContain("immutable");
  });

  it("is idempotent (one snapshot), refuses another Sponsor, records nothing for a never-submitted draft, and an unpaid cancel says no money was received", async () => {
    const c = await campaign({ kickoffInHours: 24 });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    expect((await admin.from("sponsorship_cancellations").select("money_received").eq("sponsorship_id", c.sponsorshipId)).data).toEqual([{ money_received: false }]);
    const d = await campaign({ kickoffInHours: 24, submit: false });
    await ok("sponsor_cancel_sponsorship", { p_user_id: d.sponsor.userId, p_id: d.sponsorshipId });
    expect((await admin.from("sponsorship_cancellations").select("id").eq("sponsorship_id", d.sponsorshipId)).data).toEqual([]);
    const e = await campaign({ kickoffInHours: 24, paid: true });
    const stranger = await seedSponsorAccount("stranger");
    const r = await rpc("sponsor_cancel_sponsorship", { p_user_id: stranger.userId, p_id: e.sponsorshipId });
    expect(r.error?.message ?? "").toContain("not_authorized");
  });

  it("after kickoff a LIVE campaign can be stopped by its Sponsor but is not refund-eligible, and its presentation is gone at once", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() - HOUR).toISOString() }).eq("id", c.fixtureId);
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    expect((await admin.from("sponsorship_cancellations").select("refund_eligible").eq("sponsorship_id", c.sponsorshipId).single()).data!.refund_eligible).toBe(false);
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
  });

  it("can be read by its Sponsor and Super Admin only", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    const read = async (email: string) => {
      const cl = getTestAnonClient();
      expect((await cl.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      return (await cl.from("sponsorship_cancellations").select("id").eq("sponsorship_id", c.sponsorshipId)).data ?? [];
    };
    expect((await read(c.sponsor.email)).length).toBe(1);
    expect(await read((await seedSponsorAccount("nosy")).email)).toEqual([]);
    const member = await seedUser("cancelmember");
    expect(await read((await admin.auth.admin.getUserById(member)).data.user!.email!)).toEqual([]);
    expect((await read((await admin.auth.admin.getUserById(c.adminId)).data.user!.email!)).length).toBe(1);
  });
});

describe("Brohda cancelling: its cause decides, the Sponsor's cutoff never applies, and nothing refunds by itself", () => {
  it("a Brohda-caused cancellation at T-6h is refund-eligible with a choice; a Sponsor-breach one is not; an unknown cause is refused", async () => {
    const a = await campaign({ kickoffInHours: 6, paid: true });
    await ok("admin_cancel_sponsorship", { p_admin_id: a.adminId, p_id: a.sponsorshipId, p_reason: "Brohda decision", p_cause: "BROHDA_CANCELLED_NO_BREACH" });
    expect((await admin.from("sponsorship_cancellations").select("initiator, refund_eligible, reason_code").eq("sponsorship_id", a.sponsorshipId).single()).data).toEqual({ initiator: "BROHDA", refund_eligible: true, reason_code: "BROHDA_CANCELLED_NO_BREACH" });
    expect((await payment(a.sponsorshipId)).payment_status).toBe("PAID");

    const b = await campaign({ kickoffInHours: 6, paid: true });
    await ok("admin_cancel_sponsorship", { p_admin_id: b.adminId, p_id: b.sponsorshipId, p_reason: "prohibited content", p_cause: "SPONSOR_BREACH" });
    expect((await admin.from("sponsorship_cancellations").select("refund_eligible, reason_code").eq("sponsorship_id", b.sponsorshipId).single()).data).toEqual({ refund_eligible: false, reason_code: "SPONSOR_BREACH_NO_AUTOMATIC_REFUND" });
    expect((await payment(b.sponsorshipId)).payment_status).toBe("PAID");

    const c = await campaign({ kickoffInHours: 6, paid: true });
    expect((await rpc("admin_cancel_sponsorship", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reason: "x", p_cause: "SPONSOR_CANCELLATION" })).error?.message ?? "").toContain("invalid_reason");
    const stranger = await seedUser("ordinaryadmin");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", stranger);
    staffIds.push(stranger);
    expect((await rpc("admin_cancel_sponsorship", { p_admin_id: stranger, p_id: c.sponsorshipId, p_reason: "x" })).error?.message ?? "").toContain("not_authorized");
  });

  it("the default cause keeps the old three-argument call working", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    await ok("admin_cancel_sponsorship", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reason: "x" });
    expect((await admin.from("sponsorship_cancellations").select("reason_code").eq("sponsorship_id", c.sponsorshipId).single()).data!.reason_code).toBe("BROHDA_CANCELLED_NO_BREACH");
  });

  it("a refund is still only ever the explicit audited Super Admin action, after any cancellation", async () => {
    const c = await campaign({ kickoffInHours: 24, paid: true });
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    const refund = await ok("admin_record_sponsorship_payment_event", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_event: "REFUND_PENDING", p_reference: "", p_note: "eligible at T-24h", p_idempotency_key: `r-${randomUUID()}` });
    expect(refund.payment_status).toBe("REFUND_PENDING");
    const { data: logs } = await admin.from("audit_logs").select("action").eq("entity_id", c.sponsorshipId);
    expect(logs!.map((l) => l.action)).toEqual(expect.arrayContaining(["sponsorship.refund_eligibility_decided", "sponsorship.payment_refund_pending"])); // the decision and the refund are separate records
  });
});
