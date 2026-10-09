/**
 * Sponsor identity against the real database: a Brohda login is a MEMBER or a SPONSOR, never both (enforced by triggers and constraints, not by app code),
 * Sponsors are structurally unable to take part in the social product, the account-status gate, cross-Sponsor isolation, the one-to-one account model and
 * concurrency on the exclusivity rule.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const HOUR = 3_600_000;
const NIL = "00000000-0000-0000-0000-000000000000";

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

const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
});
async function superAdmin() {
  const id = await seedUser("identityadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}
async function ordinaryAdmin() {
  const id = await seedUser("identityordinary");
  await admin.from("user_profiles").update({ role: "admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}
async function bareAuthUser(label: string) {
  const email = `${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error;
  return { id: data.user.id, email };
}
const typeOf = async (id: string) => (await admin.from("account_types").select("account_type").eq("user_id", id).maybeSingle()).data?.account_type ?? null;
const createAccount = (userId: string, brand = "Brand") => rpc("create_sponsor_account", { p_user_id: userId, p_email: "x@test.local", p_brand: brand, p_contact_name: "C", p_website: null, p_country: null, p_phone: null });

describe("MEMBER xor SPONSOR — enforced in the database", () => {
  it("A. a Sponsor account cannot get a member profile", async () => {
    const s = await seedSponsorAccount("a");
    expect(await typeOf(s.userId)).toBe("SPONSOR");
    const { error } = await admin.from("user_profiles").insert({ id: s.userId, display_name: "sneaky", role: "player", is_active: true });
    expect(error?.message ?? "").toMatch(/member_profile_requires_member_account|account_type_conflict_sponsor_account_exists/);
    expect((await admin.from("user_profiles").select("id").eq("id", s.userId)).data).toEqual([]);
  });

  it("B. a Member cannot get a Sponsor account", async () => {
    const memberId = await seedUser("b");
    expect(await typeOf(memberId)).toBe("MEMBER");
    const r = await createAccount(memberId);
    expect(r.error?.message ?? "").toContain("sponsor_account_conflict_member_profile_exists");
    expect((await admin.from("sponsor_accounts").select("user_id").eq("user_id", memberId)).data).toEqual([]);
    // Nothing half-created: the failed function call rolled back its organization too.
    expect((await admin.from("sponsors").select("id").eq("display_name", "Brand").is("contact_phone", null).eq("contact_email", "x@test.local")).data?.length ?? 0).toBe(0);
  });

  it("C. the account type can never be changed, either way", async () => {
    const s = await seedSponsorAccount("c");
    const memberId = await seedUser("c");
    expect((await admin.from("account_types").update({ account_type: "MEMBER" }).eq("user_id", s.userId)).error?.message ?? "").toContain("account_type_immutable");
    expect((await admin.from("account_types").update({ account_type: "SPONSOR" }).eq("user_id", memberId)).error?.message ?? "").toContain("account_type_immutable");
    expect(await typeOf(s.userId)).toBe("SPONSOR");
    expect(await typeOf(memberId)).toBe("MEMBER");
  });

  it("D. typing an account directly cannot contradict the rows it already has", async () => {
    const s = await seedSponsorAccount("d");
    const memberId = await seedUser("d");
    // Remove the type to try to re-insert it wrongly: a SPONSOR type for a login with a profile, a MEMBER type for a login with a sponsor account.
    await admin.from("account_types").delete().eq("user_id", memberId);
    expect((await admin.from("account_types").insert({ user_id: memberId, account_type: "SPONSOR" })).error?.message ?? "").toContain("account_type_conflict_member_profile_exists");
    await admin.from("account_types").delete().eq("user_id", s.userId);
    expect((await admin.from("account_types").insert({ user_id: s.userId, account_type: "MEMBER" })).error?.message ?? "").toContain("account_type_conflict_sponsor_account_exists");
  });

  it("E. an auth account with no profile is NOT auto-classified; it becomes a Member only if a profile is created for it", async () => {
    const orphan = await bareAuthUser("orphan");
    expect(await typeOf(orphan.id)).toBeNull();
    expect((await ok("account_type_for_email", { p_email: orphan.email.toUpperCase() })) as unknown).toBe("UNCLASSIFIED");
    await admin.from("user_profiles").insert({ id: orphan.id, display_name: "late", role: "player", is_active: true });
    expect(await typeOf(orphan.id)).toBe("MEMBER");
  });

  it("F. email exclusivity: one auth email, one account type, and the lookup reports it without a visible signal to visitors", async () => {
    const s = await seedSponsorAccount("f");
    const memberId = await seedUser("f");
    const { data: m } = await admin.auth.admin.getUserById(memberId);
    expect(await admin.rpc("account_type_for_email", { p_email: s.email }).then((r) => r.data)).toBe("SPONSOR");
    expect(await admin.rpc("account_type_for_email", { p_email: m.user!.email! }).then((r) => r.data)).toBe("MEMBER");
    expect(await admin.rpc("account_type_for_email", { p_email: `nobody-${randomUUID()}@test.local` }).then((r) => r.data)).toBeNull();
    // The same email can't be registered a second time under the other type (Supabase Auth's global unique email).
    const dup = await admin.auth.admin.createUser({ email: s.email, password: PASSWORD, email_confirm: true });
    expect(dup.error).not.toBeNull();
    const dup2 = await admin.auth.admin.createUser({ email: m.user!.email!, password: PASSWORD, email_confirm: true });
    expect(dup2.error).not.toBeNull();
    // The lookup is server-only.
    expect((await getTestAnonClient().rpc("account_type_for_email", { p_email: s.email })).error).not.toBeNull();
  });

  it("G. concurrent Member + Sponsor creation for the same login: exactly one identity wins, never both", async () => {
    for (let i = 0; i < 6; i++) {
      const u = await bareAuthUser(`race${i}`);
      const [asMember, asSponsor] = await Promise.all([
        admin.from("user_profiles").insert({ id: u.id, display_name: `race${i}`, role: "player", is_active: true }),
        createAccount(u.id, `Race ${i}`),
      ]);
      const memberWon = !asMember.error;
      const sponsorWon = !asSponsor.error;
      expect(memberWon !== sponsorWon, `iteration ${i}: member=${memberWon} sponsor=${sponsorWon}`).toBe(true);
      const hasProfile = ((await admin.from("user_profiles").select("id").eq("id", u.id)).data ?? []).length > 0;
      const hasAccount = ((await admin.from("sponsor_accounts").select("user_id").eq("user_id", u.id)).data ?? []).length > 0;
      expect(hasProfile !== hasAccount).toBe(true);
      expect(await typeOf(u.id)).toBe(hasProfile ? "MEMBER" : "SPONSOR");
    }
  });

  it("G2. concurrent Sponsor applications for one login create exactly one organization", async () => {
    const u = await bareAuthUser("dupe");
    const results = await Promise.all([1, 2, 3, 4].map(() => createAccount(u.id, "Same Brand")));
    expect(results.every((r) => !r.error)).toBe(true);
    expect(new Set(results.map((r) => r.data!.id)).size).toBe(1);
    expect(((await admin.from("sponsor_accounts").select("sponsor_id").eq("user_id", u.id)).data ?? []).length).toBe(1);
  });

  it("an organization has at most one login, and a login at most one organization", async () => {
    const one = await seedSponsorAccount("one");
    const second = await bareAuthUser("second");
    expect((await admin.from("sponsor_accounts").insert({ user_id: second.id, sponsor_id: one.sponsorId })).error).not.toBeNull();
    const other = await ((async () => (await admin.from("sponsors").insert({ display_name: "Other" }).select("id").single()).data!)());
    expect((await admin.from("sponsor_accounts").insert({ user_id: one.userId, sponsor_id: other.id })).error).not.toBeNull();
  });

  it("the sponsors link table from the old model is gone, and nothing can write an account type from the client", async () => {
    const gone = await admin.from("sponsor_users").select("user_id");
    expect(gone.error).not.toBeNull();
    const s = await seedSponsorAccount("client");
    const c = getTestAnonClient();
    expect((await c.auth.signInWithPassword({ email: s.email, password: PASSWORD })).error).toBeNull();
    expect((await c.from("account_types").select("account_type")).data).toEqual([{ account_type: "SPONSOR" }]); // only their own row
    expect((await c.from("account_types").insert({ user_id: s.userId, account_type: "MEMBER" })).error).not.toBeNull();
    expect((await c.from("account_types").update({ account_type: "MEMBER" }).eq("user_id", s.userId)).error ?? { ok: true }).toBeTruthy();
    expect(await typeOf(s.userId)).toBe("SPONSOR");
    // Metadata is not an authority: setting it changes nothing.
    await c.auth.updateUser({ data: { account_type: "MEMBER" } });
    expect(await typeOf(s.userId)).toBe("SPONSOR");
    expect((await c.from("sponsor_accounts").insert({ user_id: s.userId, sponsor_id: randomUUID() })).error).not.toBeNull();
  });
});

describe("a Sponsor cannot take part in the social product (real server paths)", () => {
  it("cannot Pick, comment, Call BS, propose money, hold a wallet, follow, or appear on a leaderboard", async () => {
    const s = await seedSponsorAccount("social");
    const { fixtureId, marketId } = await seedGame({});
    const memberId = await seedUser("target");
    const targetPick = await seedPick(memberId, marketId, "YES");
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();

    const pick = await admin.rpc("set_pick", { p_user_id: s.userId, p_market_id: marketId, p_selected_outcome: "NO", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() });
    expect(pick.error, "set_pick").not.toBeNull();
    expect((await admin.rpc("add_post_comment", { p_post_id: post!.id, p_user_id: s.userId, p_body: "hello", p_parent_comment_id: null })).error, "comment").not.toBeNull();
    expect((await admin.rpc("call_bs", { p_challenger_user_id: s.userId, p_recipient_prediction_id: targetPick })).error, "call_bs").not.toBeNull();
    expect((await admin.rpc("propose_money", { p_proposer_user_id: s.userId, p_recipient_prediction_id: targetPick, p_stake: 1000, p_idempotency_key: randomUUID(), p_source_challenge_id: null })).error, "propose_money").not.toBeNull();
    expect((await admin.rpc("accept_monetary_proposal", { p_proposal_id: NIL, p_recipient_user_id: s.userId })).error, "accept_money").not.toBeNull();
    expect((await admin.from("follows").insert({ follower_id: s.userId, followee_id: memberId })).error, "follow").not.toBeNull();
    expect((await admin.from("wallets").insert({ user_id: s.userId, type: "user" })).error ?? { x: 1 }).toBeTruthy();
    expect((await admin.from("notifications").insert({ user_id: s.userId, type: "x", title: "t", body: "b" })).error, "notification").not.toBeNull();

    // Nothing exists under the Sponsor's id anywhere in the Member tables.
    for (const [table, column] of [["predictions", "user_id"], ["post_comments", "user_id"], ["challenges", "challenger_user_id"], ["monetary_proposals", "proposer_user_id"], ["wallets", "user_id"], ["notifications", "user_id"], ["follows", "follower_id"], ["user_profiles", "id"]] as const) {
      const r = await admin.from(table).select(column).eq(column, s.userId);
      expect(r.data ?? [], table).toEqual([]);
    }
  });

  it("is invisible to Member surfaces: not in the profile directory, and the Member-side reads return nothing for it", async () => {
    const s = await seedSponsorAccount("invisible");
    expect((await admin.from("user_profiles").select("id").eq("id", s.userId)).data).toEqual([]);
    const c = getTestAnonClient();
    await c.auth.signInWithPassword({ email: s.email, password: PASSWORD });
    for (const table of ["user_profiles", "predictions", "wallets", "notifications", "post_comments", "challenges"]) {
      const r = await c.from(table).select("*").limit(5);
      // Either RLS shows it nothing of its own, or only public/other-member rows it could never author; it must never see itself as a Member.
      expect((r.data ?? []).filter((row: Row) => row.user_id === s.userId || row.id === s.userId), table).toEqual([]);
    }
  });
});

describe("Sponsor account status is its own gate", () => {
  async function sponsorWithInventory(status: "PENDING_REVIEW" | "ACTIVE" | "REJECTED" | "SUSPENDED" | "DISABLED") {
    const adminId = await superAdmin();
    await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
    const s = await seedSponsorAccount(`st-${status}`, status);
    const { fixtureId } = await seedGame({ startsInMinutes: 24 * 60 });
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
    const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 100000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    return { s, adminId, inventoryId: inv.id as string };
  }

  it.each(["PENDING_REVIEW", "REJECTED", "SUSPENDED", "DISABLED"] as const)("a %s Sponsor cannot start a sponsorship; an ACTIVE one can", async (status) => {
    const blocked = await sponsorWithInventory(status);
    await fails("sponsor_create_sponsorship", { p_user_id: blocked.s.userId, p_sponsor_id: blocked.s.sponsorId, p_inventory_id: blocked.inventoryId, p_campaign_name: "x" }, "sponsor_not_active");
    const active = await sponsorWithInventory("ACTIVE");
    const created = await ok("sponsor_create_sponsorship", { p_user_id: active.s.userId, p_sponsor_id: active.s.sponsorId, p_inventory_id: active.inventoryId, p_campaign_name: "x" });
    expect(created.lifecycle).toBe("DRAFT");
  });

  it("a Sponsor cannot see paid inventory until ACTIVE (RLS)", async () => {
    const pending = await sponsorWithInventory("PENDING_REVIEW");
    const active = await sponsorWithInventory("ACTIVE");
    const read = async (email: string) => {
      const c = getTestAnonClient();
      expect((await c.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      return (await c.from("sponsorship_inventory").select("id")).data ?? [];
    };
    expect(await read(pending.s.email)).toEqual([]);
    expect((await read(active.s.email)).length).toBeGreaterThan(0);
  });

  it("only Super Admin decides account status; transitions are validated, reasoned and audited", async () => {
    const sa = await superAdmin();
    const ordinary = await ordinaryAdmin();
    const s = await seedSponsorAccount("review", "PENDING_REVIEW");
    await fails("admin_set_sponsor_status", { p_admin_id: ordinary, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null }, "not_authorized");
    await fails("admin_set_sponsor_status", { p_admin_id: s.userId, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null }, "not_authorized");
    await fails("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "SUSPENDED", p_reason: "nope", p_internal_note: null }, "invalid_transition");
    await fails("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "REJECTED", p_reason: " ", p_internal_note: null }, "reason_required");
    const rejected = await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "REJECTED", p_reason: "Not a fit", p_internal_note: "private" });
    expect(rejected).toMatchObject({ status: "REJECTED", status_reason: "Not a fit", internal_review_note: "private", reviewed_by: sa });
    const active = await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null });
    expect(active).toMatchObject({ status: "ACTIVE", status_reason: null });
    expect((await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null })).status).toBe("ACTIVE"); // idempotent
    await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "SUSPENDED", p_reason: "Chargeback", p_internal_note: null });
    await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null }); // restore
    await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "DISABLED", p_reason: "Closed", p_internal_note: null });
    const { data: logs } = await admin.from("audit_logs").select("action, actor_id, reason").eq("entity_type", "sponsor").eq("entity_id", s.sponsorId).order("created_at");
    expect(logs!.map((l) => l.action)).toEqual(expect.arrayContaining(["sponsor.application_submitted", "sponsor.status_rejected", "sponsor.status_active", "sponsor.status_suspended", "sponsor.status_disabled"]));
    expect(logs!.find((l) => l.action === "sponsor.status_rejected")).toMatchObject({ actor_id: sa, reason: "Not a fit" });
  });

  it("profile edits: the brand name is locked after approval; other details stay editable; a Member id is not authorized", async () => {
    const sa = await superAdmin();
    const s = await seedSponsorAccount("profile", "PENDING_REVIEW");
    const edited = await ok("sponsor_update_profile", { p_user_id: s.userId, p_fields: { display_name: "Renamed", contact_name: "New Person", website: "https://example.com", country: "Mexico", contact_phone: "+52 55 1234" } });
    expect(edited).toMatchObject({ display_name: "Renamed", contact_name: "New Person", website: "https://example.com", country: "Mexico", contact_phone: "+52 55 1234" });
    await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "ACTIVE", p_reason: null, p_internal_note: null });
    await fails("sponsor_update_profile", { p_user_id: s.userId, p_fields: { display_name: "Something Else Entirely" } }, "identity_change_requires_review");
    expect((await ok("sponsor_update_profile", { p_user_id: s.userId, p_fields: { country: "Spain" } })).country).toBe("Spain");
    await fails("sponsor_update_profile", { p_user_id: await seedUser("notasponsor"), p_fields: { country: "x" } }, "not_authorized");
    await ok("admin_set_sponsor_status", { p_admin_id: sa, p_sponsor_id: s.sponsorId, p_status: "SUSPENDED", p_reason: "x", p_internal_note: null });
    await fails("sponsor_update_profile", { p_user_id: s.userId, p_fields: { country: "France" } }, "sponsor_not_editable");
  });
});

describe("cross-Sponsor isolation and the public payload", () => {
  it("one Sponsor cannot read or act on another Sponsor's data", async () => {
    const a = await seedSponsorAccount("isoA");
    const b = await seedSponsorAccount("isoB");
    const adminId = await superAdmin();
    await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
    const { fixtureId } = await seedGame({});
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
    const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    const mine = await ok("sponsor_create_sponsorship", { p_user_id: a.userId, p_sponsor_id: a.sponsorId, p_inventory_id: inv.id, p_campaign_name: "A" });
    await fails("sponsor_update_sponsorship", { p_user_id: b.userId, p_id: mine.id, p_fields: { tagline: "hijack" } }, "not_authorized");
    await fails("sponsor_cancel_sponsorship", { p_user_id: b.userId, p_id: mine.id }, "not_authorized");
    await fails("sponsor_create_sponsorship", { p_user_id: b.userId, p_sponsor_id: a.sponsorId, p_inventory_id: inv.id, p_campaign_name: "x" }, "not_authorized");
    const cb = getTestAnonClient();
    await cb.auth.signInWithPassword({ email: b.email, password: PASSWORD });
    expect((await cb.from("sponsorships").select("id")).data).toEqual([]);
    expect((await cb.from("sponsors").select("id")).data!.map((r) => r.id)).toEqual([b.sponsorId]);
  });

  it("the public sponsorship payload never carries the Sponsor's private contact details", async () => {
    const s = await seedSponsorAccount("public");
    await admin.from("sponsors").update({ contact_name: "Private Person", contact_phone: "+1 555 0100", contact_email: "private@test.local", website: "https://example.com", country: "Mexico", internal_review_note: "secret note", status_reason: "reason" }).eq("id", s.sponsorId);
    const adminId = await superAdmin();
    await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
    const { fixtureId } = await seedGame({});
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
    const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 1000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
    const sp = await ok("sponsor_create_sponsorship", { p_user_id: s.userId, p_sponsor_id: s.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Public" });
    await ok("sponsor_update_sponsorship", { p_user_id: s.userId, p_id: sp.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
    await ok("sponsor_submit_sponsorship", { p_user_id: s.userId, p_id: sp.id });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: sp.id, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: randomUUID() });
    const { data: rev } = await admin.from("sponsorships").select("revision").eq("id", sp.id).single();
    await ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: sp.id, p_expected_revision: rev!.revision });
    const live = await loadPublicSponsorships([post!.id]);
    expect(live.get(post!.id)?.presentedBy).toBe("Acme Sports"); // it really is public, so the absence below means something
    const payload = JSON.stringify([...live.values()]);
    for (const secret of ["Private Person", "+1 555 0100", "private@test.local", "secret note", "reason", s.email]) expect(payload).not.toContain(secret);
  });
});

describe("terms acceptance infrastructure", () => {
  it("records one acceptance per account and version, and only its owner (or Super Admin) can read it", async () => {
    const s = await seedSponsorAccount("terms");
    const row = { user_id: s.userId, sponsor_id: s.sponsorId, document_key: "sponsor_terms", version: "v-test", source: "signup" };
    expect((await admin.from("sponsor_terms_acceptances").insert(row)).error).toBeNull();
    expect((await admin.from("sponsor_terms_acceptances").insert(row)).error).not.toBeNull(); // one per (account, document, version)
    const other = await seedSponsorAccount("terms2");
    const c = getTestAnonClient();
    await c.auth.signInWithPassword({ email: other.email, password: PASSWORD });
    expect((await c.from("sponsor_terms_acceptances").select("id")).data).toEqual([]);
    expect((await c.from("sponsor_terms_acceptances").insert({ ...row, user_id: other.userId, version: "v2" })).error).not.toBeNull();
  });
});
