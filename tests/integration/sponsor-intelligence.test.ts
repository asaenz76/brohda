/**
 * Sponsor Intelligence foundation (migration 196) against the real database: exact aggregates, Member-only counting, the window, no Member-level data in the output, who can
 * call what, the fail-closed capability, the Sponsor-only view with small-cohort suppression, ownership, and the audited settings.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedPick, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { ensureTeamCommunity } from "@/lib/communities/repository";
import { getAdminCampaignResults, getSponsorCampaignResults, getSponsorIntelligenceConfig } from "@/lib/sponsor-intelligence/service";

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

const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
const intelligence = (enabled: boolean, minCohort = 10, lookback = 90) => setSettings({ sponsor_intelligence_enabled: enabled, sponsor_intelligence_min_cohort: minCohort, sponsor_intelligence_affinity_lookback_days: lookback });

let saved: Row | null = null;
beforeEach(async () => {
  const { data } = await admin.from("platform_settings").select("sponsorship_enabled, sponsor_intelligence_enabled, sponsor_intelligence_min_cohort, sponsor_intelligence_affinity_lookback_days").eq("id", true).single();
  saved = data;
  await setSettings({ sponsorship_enabled: true });
  await intelligence(false);
});
afterEach(async () => {
  if (saved) await setSettings(saved);
});

// Test accounts are never deleted; staff roles handed out here are taken back so other files' "every admin" assertions never see them.
const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
});

async function staff(role: "admin" | "super_admin") {
  const id = await seedUser(`intel-${role}`);
  await admin.from("user_profiles").update({ role }).eq("id", id);
  staffIds.push(id);
  return id;
}

/** A sponsor, a published Game Post with one Market, a window that started an hour ago, and a draft campaign on it. Optionally approved + paid so it counts as LIVE. */
async function campaign(sponsor: { sponsorId: string; userId: string }, opts: { live?: boolean } = {}) {
  const adminId = await staff("super_admin");
  const { fixtureId, marketId } = await seedGame({ startsInMinutes: 24 * 60 });
  const { data: post, error } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (error || !post) throw error;
  const inv = await ok("admin_set_sponsorship_inventory", {
    p_admin_id: adminId, p_post_id: post.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 100000, p_currency: "USD",
    p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString(),
  });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Intel" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme", tagline: "t", cta_text: "c", destination_url: "https://acme.example.com" } });
  if (opts.live) {
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: created.id, p_reference: "INV", p_note: "t", p_idempotency_key: `k-${randomUUID()}` });
    const { data: row } = await admin.from("sponsorships").select("revision").eq("id", created.id).single();
    await ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: created.id, p_expected_revision: row!.revision });
  }
  return { id: created.id as string, postId: post.id as string, fixtureId, marketId, adminId };
}

const impression = (sponsorshipId: string, postId: string, userId: string) => admin.from("sponsorship_exposure_events").insert({ sponsorship_id: sponsorshipId, post_id: postId, event_type: "IMPRESSION", user_id: userId });
const click = (sponsorshipId: string, postId: string, userId: string | null) => admin.from("sponsorship_exposure_events").insert({ sponsorship_id: sponsorshipId, post_id: postId, event_type: "CLICK", user_id: userId });
const aggregates = async (id: string, lookback = 90) => (await ok("sponsor_intelligence_aggregates", { p_sponsorship_id: id, p_lookback_days: lookback })) as unknown as Row;

describe("exact aggregates", () => {
  it("count only Members, only inside the window, and contain no Member-level data", async () => {
    const sponsor = await seedSponsorAccount("IntelAgg");
    const c = await campaign(sponsor);
    const members = [await seedUser("m1"), await seedUser("m2"), await seedUser("m3")];
    const staffMember = await staff("admin");

    for (const m of members) expect((await impression(c.id, c.postId, m)).error).toBeNull();
    expect((await impression(c.id, c.postId, staffMember)).error).toBeNull(); // staff testing: never counted
    expect((await click(c.id, c.postId, members[0])).error).toBeNull();
    expect((await click(c.id, c.postId, null)).error).toBeNull(); // an anonymous visitor's click counts
    expect((await click(c.id, c.postId, staffMember)).error).toBeNull(); // staff click: not counted

    // Picks: two Members pick the Market (distinct Members + distinct Picks); the staff member's Pick is not counted.
    await seedPick(members[0], c.marketId, "YES");
    await seedPick(members[1], c.marketId, "NO");
    await seedPick(staffMember, c.marketId, "YES");
    // A comment from a Member counts; a deleted one and a staff one do not.
    await admin.from("post_comments").insert([
      { post_id: c.postId, user_id: members[0], body: "counted" },
      { post_id: c.postId, user_id: members[1], body: "deleted", deleted_at: new Date().toISOString() },
      { post_id: c.postId, user_id: staffMember, body: "staff" },
    ]);

    const a = await aggregates(c.id);
    expect(a.started).toBe(true);
    expect(a.uniqueViewers).toBe(3);
    expect(a.impressions).toBe(3);
    expect(a.clicks).toBe(2); // one Member + one anonymous
    expect(a.pickMembers).toBe(2);
    expect(a.picks).toBe(2);
    expect(a.comments).toBe(1);
    expect(a.commenters).toBe(1);

    // Nothing Member-level anywhere in the document: no id, no e-mail, no name.
    const text = JSON.stringify(a);
    for (const id of [...members, staffMember]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/@test\.local|display_name|username|email/i);
  });

  it("a campaign that has not started presenting reports started=false and no counts of Picks, comments or Call BS", async () => {
    const sponsor = await seedSponsorAccount("IntelFuture");
    const c = await campaign(sponsor);
    await admin.from("sponsorships").update({ starts_at: new Date(Date.now() + 2 * HOUR).toISOString() }).eq("id", c.id);
    const member = await seedUser("future");
    await seedPick(member, c.marketId, "YES");
    const a = await aggregates(c.id);
    expect(a.started).toBe(false);
    expect(a.picks).toBe(0);
    expect(a.pickMembers).toBe(0);
    expect(a.windowEnd).toBeNull();
  });

  it("Picks and comments made BEFORE the window opened are not attributed to the campaign", async () => {
    const sponsor = await seedSponsorAccount("IntelWindow");
    const c = await campaign(sponsor);
    const member = await seedUser("early");
    const pickId = await seedPick(member, c.marketId, "YES");
    await admin.from("predictions").update({ created_at: new Date(Date.now() - 3 * HOUR).toISOString() }).eq("id", pickId); // before starts_at (-1h)
    await admin.from("post_comments").insert({ post_id: c.postId, user_id: member, body: "early", created_at: new Date(Date.now() - 3 * HOUR).toISOString() });
    const a = await aggregates(c.id);
    expect(a.picks).toBe(0);
    expect(a.comments).toBe(0);
  });

  it("counts Call BS between Members on the sponsored Game, and returning Members across the same Sponsor's campaigns", async () => {
    const sponsor = await seedSponsorAccount("IntelReturn");
    const a1 = await campaign(sponsor, { live: true });
    const a2 = await campaign(sponsor, { live: true });
    const x = await seedUser("rx");
    const y = await seedUser("ry");
    const xPick = await seedPick(x, a1.marketId, "YES");
    const yPick = await seedPick(y, a1.marketId, "NO");
    await seedPick(x, a2.marketId, "YES"); // x also picked on the Sponsor's other campaign: returning
    await seedPick(y, (await seedGame()).marketId, "YES"); // y picked elsewhere: not returning
    const { error } = await admin.from("challenges").insert({
      market_id: a1.marketId, challenger_user_id: x, recipient_user_id: y, challenger_prediction_id: xPick, recipient_prediction_id: yPick,
      challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "PENDING",
    });
    expect(error, error?.message).toBeNull();

    const first = await aggregates(a1.id);
    expect(first.pickMembers).toBe(2);
    expect(first.returningMembers).toBe(1);
    expect(first.callBsChallenges).toBe(1);
    expect(first.callBsMembers).toBe(2);
    const second = await aggregates(a2.id);
    expect(second.pickMembers).toBe(1);
    expect(second.returningMembers).toBe(1); // x picked on a1 as well
  });

  it("builds sport and Team affinity for the Members reached, from Picks and Team follows", async () => {
    const sponsor = await seedSponsorAccount("IntelAffinity");
    const c = await campaign(sponsor);
    const members = [await seedUser("af1"), await seedUser("af2")];
    for (const m of members) await impression(c.id, c.postId, m);
    const basketball = await seedGame({ sport: "basketball" });
    await seedPick(members[0], basketball.marketId, "YES");
    await seedPick(members[1], c.marketId, "YES"); // american_football
    await seedPick(members[0], c.marketId, "NO");
    const a = await aggregates(c.id);
    const bySport = Object.fromEntries((a.sportAffinity as Array<{ key: string; count: number }>).map((s) => [s.key, s.count]));
    expect(bySport.basketball).toBe(1);
    expect(bySport.american_football).toBe(2);
    expect(a.teamAffinity).toEqual([]); // nobody follows a Team yet: honest empty, not invented
    expect(a.affinityLookbackDays).toBe(90);
  });

  it("counts Team affinity from Team-community follows among the Members reached, and not from Members who never saw it", async () => {
    const sponsor = await seedSponsorAccount("IntelTeams");
    const c = await campaign(sponsor);
    const reached = [await seedUser("tf1"), await seedUser("tf2")];
    const notReached = await seedUser("tf3");
    for (const m of reached) await impression(c.id, c.postId, m);
    const { data: team } = await admin.from("teams").insert({ provider: "api_nfl", external_id: `intel-team-${randomUUID()}`, name: "Intel Test Team" }).select("id").single();
    const { id: communityId } = await ensureTeamCommunity(team!.id);
    await admin.from("community_follows").insert([...reached, notReached].map((u) => ({ user_id: u, community_id: communityId })));
    try {
      const a = await aggregates(c.id);
      expect(a.teamAffinity).toEqual([{ key: team!.id, label: "Intel Test Team", count: 2 }]); // the third follower never saw the campaign
    } finally {
      await admin.from("community_follows").delete().eq("community_id", communityId);
      await admin.from("communities").delete().eq("id", communityId);
      await admin.from("teams").delete().eq("id", team!.id);
    }
  });

  it("counts repeat viewers, viewers who picked, replies, accepted Call BS and per-Market Picks — and carries no monetary field", async () => {
    const sponsor = await seedSponsorAccount("IntelV11");
    const c = await campaign(sponsor);
    const [v1, v2, v3, outsider] = [await seedUser("v1"), await seedUser("v2"), await seedUser("v3"), await seedUser("outsider")];
    const yesterday = new Date(Date.now() - 24 * HOUR).toISOString().slice(0, 10);
    await impression(c.id, c.postId, v1);
    // The same Member on a second day: a repeat viewer. (One per Member per day is the stored definition.)
    await admin.from("sponsorship_exposure_events").insert({ sponsorship_id: c.id, post_id: c.postId, event_type: "IMPRESSION", user_id: v1, day_utc: yesterday });
    await impression(c.id, c.postId, v2);
    await impression(c.id, c.postId, v3);

    const p1 = await seedPick(v1, c.marketId, "YES");
    const p2 = await seedPick(v2, c.marketId, "NO");
    await seedPick(outsider, c.marketId, "YES"); // picked without ever being counted as a viewer

    const { data: top } = await admin.from("post_comments").insert({ post_id: c.postId, user_id: v1, body: "top-level" }).select("id").single();
    await admin.from("post_comments").insert({ post_id: c.postId, user_id: v2, body: "a reply", parent_comment_id: top!.id });
    const { error } = await admin.from("challenges").insert({
      market_id: c.marketId, challenger_user_id: v1, recipient_user_id: v2, challenger_prediction_id: p1, recipient_prediction_id: p2,
      challenger_selection_snapshot: "YES", recipient_selection_snapshot: "NO", status: "ACCEPTED", accepted_at: new Date().toISOString(),
    });
    expect(error, error?.message).toBeNull();

    const a = await aggregates(c.id);
    expect(a.uniqueViewers).toBe(3);
    expect(a.impressions).toBe(4);
    expect(a.repeatViewers).toBe(1);
    expect(a.pickMembers).toBe(3);
    expect(a.viewersWhoPicked).toBe(2); // v1 and v2 saw it and picked; the outsider picked without a counted view; v3 saw it and did not pick
    expect(a.comments).toBe(1);
    expect(a.replies).toBe(1);
    expect(a.commenters).toBe(2);
    expect(a.callBsChallenges).toBe(1);
    expect(a.callBsAccepted).toBe(1);
    expect(a.callBsAnswered).toBe(1);
    expect(a.callBsMembers).toBe(2);
    expect(a.callBsPickers).toBe(2);
    expect(a.game).toEqual({ homeTeamName: "Seed Home", awayTeamName: "Seed Away", sport: "american_football" });
    expect(a.markets).toHaveLength(1);
    expect(a.markets[0]).toMatchObject({ marketId: c.marketId, template: "MONEYLINE", members: 3, yesCount: 2, noCount: 1 });

    // No monetary, wallet or Member-level field exists anywhere in the document.
    const text = JSON.stringify(a);
    expect(text).not.toMatch(/wallet|stake|wager|monetary|position|p2p|deposit|withdraw|fee|settle|balance|payout|usdt|amount|price/i);
    for (const id of [v1, v2, v3, outsider]) expect(text).not.toContain(id);
  });

  it("splits Picks and Members correctly across the Markets of the sponsored Game", async () => {
    const sponsor = await seedSponsorAccount("IntelMarkets");
    const c = await campaign(sponsor);
    const second = await admin
      .from("markets")
      .insert({ provider: "api_nfl", provider_market_id: `intel_${randomUUID()}`, question: "q?", status: "ACTIVE", fixture_id: c.fixtureId, market_template: "TOTAL", line_value: 47.5, ingestion_source: "test", yes_price: 0.5, no_price: 0.5, liquidity: 1000, last_synced_at: new Date().toISOString() })
      .select("id")
      .single();
    expect(second.error, second.error?.message).toBeNull();
    const [a, b] = [await seedUser("mk1"), await seedUser("mk2")];
    await seedPick(a, c.marketId, "YES");
    await seedPick(b, c.marketId, "YES");
    await seedPick(a, second.data!.id, "NO");
    const agg = await aggregates(c.id);
    const byId = Object.fromEntries((agg.markets as Row[]).map((m) => [m.marketId, m]));
    expect(byId[c.marketId]).toMatchObject({ members: 2, yesCount: 2, noCount: 0 });
    expect(byId[second.data!.id]).toMatchObject({ template: "TOTAL", lineValue: 47.5, members: 1, yesCount: 0, noCount: 1 });
    expect(agg.picks).toBe(3);
    expect(agg.pickMembers).toBe(2);
  });

  it("Call BS: counts every challenge, the accepted ones, and only the ANSWERED ones (accepted or declined) as the acceptance-rate denominator", async () => {
    const sponsor = await seedSponsorAccount("IntelCallBs");
    const c = await campaign(sponsor);
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => seedUser(`cb${i}`)));
    const picks: string[] = [];
    for (const [i, u] of users.entries()) picks.push(await seedPick(u, c.marketId, i % 2 === 0 ? "YES" : "NO"));
    const row = (a: number, b: number, extra: Record<string, unknown>) => ({
      market_id: c.marketId, challenger_user_id: users[a], recipient_user_id: users[b], challenger_prediction_id: picks[a], recipient_prediction_id: picks[b],
      challenger_selection_snapshot: a % 2 === 0 ? "YES" : "NO", recipient_selection_snapshot: b % 2 === 0 ? "YES" : "NO", ...extra,
    });
    const now = new Date().toISOString();
    const { error } = await admin.from("challenges").insert([
      row(0, 1, { status: "PENDING" }), // not answered yet
      row(2, 3, { status: "DECLINED", declined_at: now }), // answered: declined
      row(4, 5, { status: "EXPIRED" }), // not answered: expiry does not record why, so it is not counted
      row(6, 7, { status: "ACCEPTED", accepted_at: now }), // answered: accepted
      row(8, 9, { status: "RESOLVED", accepted_at: now, resolved_at: now, result: "VOID" }), // answered: accepted, then decided
    ]);
    expect(error, error?.message).toBeNull();
    const a = await aggregates(c.id);
    expect(a.callBsChallenges).toBe(5);
    expect(a.callBsAccepted).toBe(2);
    expect(a.callBsAnswered).toBe(3);
    expect(a.callBsMembers).toBe(10);
  });

  it("returns null for a sponsorship that does not exist", async () => {
    const r = await rpc("sponsor_intelligence_aggregates", { p_sponsorship_id: randomUUID(), p_lookback_days: 90 });
    expect(r.error).toBeNull();
    expect(r.data).toBeNull();
  });
});

describe("who can call it", () => {
  it("only the server (service role): the public and a signed-in Member are refused, for both functions", async () => {
    const sponsor = await seedSponsorAccount("IntelAuth");
    const c = await campaign(sponsor);
    const memberId = await seedUser("auth-member");
    const { data: u } = await admin.auth.admin.getUserById(memberId);

    const anon = getTestAnonClient();
    expect((await anon.rpc("sponsor_intelligence_aggregates", { p_sponsorship_id: c.id, p_lookback_days: 90 })).error).not.toBeNull();
    expect((await anon.rpc("admin_set_sponsor_intelligence_config", { p_admin_id: memberId, p_enabled: true, p_min_cohort: 2, p_lookback_days: 1 })).error).not.toBeNull();

    const asMember = getTestAnonClient();
    const signedIn = await asMember.auth.signInWithPassword({ email: u.user!.email!, password: PASSWORD });
    expect(signedIn.error).toBeNull();
    expect((await asMember.rpc("sponsor_intelligence_aggregates", { p_sponsorship_id: c.id, p_lookback_days: 90 })).error).not.toBeNull();
    expect((await asMember.rpc("admin_set_sponsor_intelligence_config", { p_admin_id: memberId, p_enabled: true, p_min_cohort: 2, p_lookback_days: 1 })).error).not.toBeNull();
    // The raw exposure table stays Super-Admin-only: a Member reads nothing.
    expect((await asMember.from("sponsorship_exposure_events").select("id")).data).toEqual([]);
  });

  it("a Sponsor login cannot read the exposure table or call the functions, and has no Member profile to be counted under", async () => {
    const sponsor = await seedSponsorAccount("IntelSponsorAuth");
    const c = await campaign(sponsor);
    const asSponsor = getTestAnonClient();
    expect((await asSponsor.auth.signInWithPassword({ email: sponsor.email, password: PASSWORD })).error).toBeNull();
    expect((await asSponsor.from("sponsorship_exposure_events").select("id")).data).toEqual([]);
    expect((await asSponsor.rpc("sponsor_intelligence_aggregates", { p_sponsorship_id: c.id, p_lookback_days: 90 })).error).not.toBeNull();
    // A Sponsor login can never become an impression: it has no user_profiles row, which the exposure table requires.
    expect((await impression(c.id, c.postId, sponsor.userId)).error).not.toBeNull();
  });
});

describe("the settings", () => {
  it("default OFF with a threshold of 10, a 90-day look-back, and the database refuses a threshold below 2", async () => {
    const { data } = await admin.from("platform_settings").select("sponsor_intelligence_enabled, sponsor_intelligence_min_cohort, sponsor_intelligence_affinity_lookback_days").eq("id", true).single();
    // beforeEach switched it off with the documented defaults.
    expect(data).toEqual({ sponsor_intelligence_enabled: false, sponsor_intelligence_min_cohort: 10, sponsor_intelligence_affinity_lookback_days: 90 });
    for (const bad of [1, 0, -1, 10001]) {
      expect((await admin.from("platform_settings").update({ sponsor_intelligence_min_cohort: bad }).eq("id", true)).error, `min cohort ${bad}`).not.toBeNull();
    }
    for (const bad of [0, 731]) {
      expect((await admin.from("platform_settings").update({ sponsor_intelligence_affinity_lookback_days: bad }).eq("id", true)).error, `look-back ${bad}`).not.toBeNull();
    }
  });

  it("only a Super Admin can change them, with validated values, and a real change is audited", async () => {
    const superId = await staff("super_admin");
    const plainAdmin = await staff("admin");
    const member = await seedUser("settings-member");
    for (const who of [plainAdmin, member]) {
      expect((await rpc("admin_set_sponsor_intelligence_config", { p_admin_id: who, p_enabled: true, p_min_cohort: 5, p_lookback_days: 30 })).error).not.toBeNull();
    }
    for (const bad of [{ p_min_cohort: 1, p_lookback_days: 30 }, { p_min_cohort: 5, p_lookback_days: 0 }, { p_min_cohort: null, p_lookback_days: 30 }]) {
      expect((await rpc("admin_set_sponsor_intelligence_config", { p_admin_id: superId, p_enabled: true, ...bad })).error, JSON.stringify(bad)).not.toBeNull();
    }
    const before = (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.sponsor_intelligence_updated")).count ?? 0;
    await ok("admin_set_sponsor_intelligence_config", { p_admin_id: superId, p_enabled: true, p_min_cohort: 5, p_lookback_days: 30 });
    const after = (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.sponsor_intelligence_updated")).count ?? 0;
    expect(after).toBe(before + 1);
    // Saving the same values again changes nothing, so it writes no audit entry.
    await ok("admin_set_sponsor_intelligence_config", { p_admin_id: superId, p_enabled: true, p_min_cohort: 5, p_lookback_days: 30 });
    expect(((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.sponsor_intelligence_updated")).count ?? 0)).toBe(after);
    const cfg = await getSponsorIntelligenceConfig();
    expect(cfg).toEqual({ enabled: true, minCohort: 5, affinityLookbackDays: 30 });
  });
});

describe("what a Sponsor is shown", () => {
  async function seeded(memberCount: number) {
    const sponsor = await seedSponsorAccount("IntelView");
    const c = await campaign(sponsor);
    for (let i = 0; i < memberCount; i++) {
      const m = await seedUser(`view${i}`);
      await impression(c.id, c.postId, m);
      await seedPick(m, c.marketId, i % 2 === 0 ? "YES" : "NO");
    }
    return { sponsor, c };
  }

  it("shows NOTHING while the capability is OFF — even though the numbers exist", async () => {
    const { sponsor, c } = await seeded(4);
    await intelligence(false, 2);
    expect(await getSponsorCampaignResults(sponsor.userId, c.id)).toEqual({ state: "off" });
    const exact = await getAdminCampaignResults(c.id);
    expect(exact.state).toBe("ready");
    if (exact.state === "ready") {
      expect(exact.capabilityEnabled).toBe(false);
      expect(exact.report.exact.uniqueViewers).toBe(4); // Super Admin still has the exact figures
    }
  });

  it("withholds every figure below the threshold", async () => {
    const { sponsor, c } = await seeded(4);
    await intelligence(true, 10);
    const r = await getSponsorCampaignResults(sponsor.userId, c.id);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.report.metrics.uniqueViewers).toBeNull();
    expect(r.report.metrics.impressions).toBeNull();
    expect(r.report.metrics.pickMembers).toBeNull();
    expect(r.report.metrics.picks).toBeNull();
    expect(r.report.minCohort).toBe(10);
    // Zero is safe to show: nobody commented.
    expect(r.report.metrics.comments).toBe(0);
  });

  it("shows aggregate figures once the cohort is large enough, with no Member-level field", async () => {
    const { sponsor, c } = await seeded(4);
    await intelligence(true, 3);
    const r = await getSponsorCampaignResults(sponsor.userId, c.id);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.report.metrics.uniqueViewers).toBe(4);
    expect(r.report.metrics.pickMembers).toBe(4);
    expect(JSON.stringify(r)).not.toMatch(/user_?id|email|@test\.local/i);
  });

  it("is limited to the Sponsor's OWN campaign: another Sponsor, a Member and a missing id all get 'not found'", async () => {
    const { c } = await seeded(3);
    await intelligence(true, 2);
    const other = await seedSponsorAccount("IntelOther");
    expect(await getSponsorCampaignResults(other.userId, c.id)).toEqual({ state: "not_found" });
    expect(await getSponsorCampaignResults(await seedUser("not-a-sponsor"), c.id)).toEqual({ state: "not_found" });
    expect(await getSponsorCampaignResults(other.userId, randomUUID())).toEqual({ state: "not_found" });
  });

  it("reports 'not started' before the window opens, and never leaks the exact numbers through the Sponsor view", async () => {
    const sponsor = await seedSponsorAccount("IntelNotStarted");
    const c = await campaign(sponsor);
    await admin.from("sponsorships").update({ starts_at: new Date(Date.now() + 3 * HOUR).toISOString() }).eq("id", c.id);
    await intelligence(true, 2);
    expect(await getSponsorCampaignResults(sponsor.userId, c.id)).toEqual({ state: "not_started" });
  });

  it("the Super Admin view says exactly which figures the Sponsor would not be shown", async () => {
    const { c } = await seeded(4);
    await intelligence(true, 5);
    const r = await getAdminCampaignResults(c.id);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.capabilityEnabled).toBe(true);
    expect(r.report.exact.uniqueViewers).toBe(4);
    expect(r.report.suppressedForSponsor).toContain("uniqueViewers");
    expect(r.report.sponsorView.metrics.uniqueViewers).toBeNull();
  });

  it("flipping the switch OFF removes access immediately, with no restart", async () => {
    const { sponsor, c } = await seeded(3);
    await intelligence(true, 2);
    expect((await getSponsorCampaignResults(sponsor.userId, c.id)).state).toBe("ready");
    await intelligence(false, 2);
    expect(await getSponsorCampaignResults(sponsor.userId, c.id)).toEqual({ state: "off" });
  });
});
