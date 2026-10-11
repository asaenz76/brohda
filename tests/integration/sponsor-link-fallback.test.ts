/**
 * Optional destination link + Sponsor-website fallback, against the real database, the real approval functions and the real first-party click route.
 * Proved: a campaign needs no destination link; where a sponsored post links is own link ?? Sponsor profile website ?? none; the effective destination is FROZEN at approval so a
 * later profile edit can't move a live post; a campaign-link change still voids approval; the click path serves only the frozen value and records exactly one click (none when there
 * is no link); URL validation is unchanged; nothing but a boolean reaches the public.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { resolveEffectiveSponsorUrl } from "@/lib/sponsorship/destination";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/session")>()), getCurrentUser: async () => null }));

const admin = getTestAdminClient();
const HOUR = 3_600_000;
const SITE_A = "https://berria.example.com";
const CAMPAIGN_B = "https://berria.example.com/launch";
const SITE_C = "https://new-site.example.com";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let clickRoute: typeof import("@/app/sponsorship/click/[id]/route");
let adminId = "";
const staffIds: string[] = [];

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  clickRoute = await import("@/app/sponsorship/click/[id]/route");
  adminId = await seedUser("linkadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", adminId);
  staffIds.push(adminId);
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
});
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
});

const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: (Array.isArray(data) ? data[0] : data) as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};

/** A SUBMITTED sponsorship of an ACTIVE Sponsor whose profile website is `website`, with an optional campaign destination. */
async function campaign(opts: { website?: string | null; destination?: string | null } = {}) {
  const sponsor = await seedSponsorAccount("link");
  await admin.from("sponsors").update({ website: opts.website === undefined ? SITE_A : opts.website }).eq("id", sponsor.sponsorId);
  const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 40000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Link" });
  const fields: Record<string, unknown> = { presented_by: "Berria Bikes", tagline: "Ride", cta_text: "Learn more" };
  if (opts.destination) fields.destination_url = opts.destination;
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: fields });
  return { sponsor, sponsorshipId: created.id as string, postId: post!.id as string };
}
const submit = (c: { sponsor: { userId: string }; sponsorshipId: string }) => rpc("sponsor_submit_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
const row = async (id: string) => (await admin.from("sponsorships").select("*").eq("id", id).single()).data as Row;
const approve = async (c: { sponsorshipId: string }, expectedDestination?: string) => {
  const s = await row(c.sponsorshipId);
  return rpc("admin_approve_sponsorship", { p_admin_id: adminId, p_id: c.sponsorshipId, p_expected_revision: s.revision, ...(expectedDestination === undefined ? {} : { p_expected_destination: expectedDestination }) });
};
const pay = (c: { sponsorshipId: string }) => ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: c.sponsorshipId, p_reference: "INV", p_note: "bank", p_idempotency_key: randomUUID() });
/** Submitted, paid, approved → on the clock. */
async function live(opts: Parameters<typeof campaign>[0] = {}) {
  const c = await campaign(opts);
  expect((await submit(c)).error).toBeNull();
  await pay(c);
  expect((await approve(c)).error).toBeNull();
  return c;
}
const clicks = async (id: string) => (await admin.from("sponsorship_exposure_events").select("id").eq("sponsorship_id", id).eq("event_type", "CLICK")).data!.length;
const click = (id: string) => clickRoute.GET(new Request(`http://localhost/sponsorship/click/${id}`), { params: Promise.resolve({ id }) });

describe("the destination link is OPTIONAL — enforced in the database, not only the form", () => {
  it("submits with no campaign destination when the Sponsor has a profile website", async () => {
    const c = await campaign({ destination: null });
    const r = await submit(c);
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ lifecycle: "SUBMITTED", destination_url: null });
  });

  it("submits with no campaign destination AND no Sponsor website — nothing blocks it", async () => {
    const c = await campaign({ destination: null, website: null });
    expect((await submit(c)).error).toBeNull();
  });

  it("still requires what has always been required (Sponsor name, logo), but no longer the link", async () => {
    const c = await campaign({ destination: null });
    await ok("sponsor_update_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId, p_fields: { presented_by: "" } });
    expect((await submit(c)).error?.message).toMatch(/incomplete_sponsorship/);
    await admin.from("sponsorships").update({ presented_by: "Berria Bikes", logo_path: null }).eq("id", c.sponsorshipId);
    expect((await submit(c)).error?.message).toMatch(/incomplete_sponsorship/);
  });

  it("a destination that IS supplied is still validated (nothing weakened)", async () => {
    const c = await campaign();
    for (const bad of ["javascript:alert(1)", "ftp://files.example.com/x", "data:text/html,hi", "not a url"]) {
      const r = await rpc("sponsor_update_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId, p_fields: { destination_url: bad } });
      expect(r.error, bad).not.toBeNull();
    }
    expect((await admin.from("sponsors").update({ website: "javascript:alert(1)" }).eq("id", c.sponsor.sponsorId)).error).not.toBeNull();
    expect((await rpc("sponsor_update_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId, p_fields: { destination_url: CAMPAIGN_B } })).error).toBeNull();
  });

  it("a Super Admin submitting on the Sponsor's behalf needs no link either", async () => {
    const c = await campaign({ destination: null });
    expect((await rpc("admin_submit_sponsorship", { p_admin_id: adminId, p_id: c.sponsorshipId })).error).toBeNull();
  });
});

describe("priority: campaign destination ?? Sponsor website ?? none — resolved once, frozen at approval", () => {
  it("campaign link B overrides profile website A", async () => {
    const c = await campaign({ destination: CAMPAIGN_B });
    await submit(c);
    await approve(c);
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe(CAMPAIGN_B);
  });

  it("no campaign link → the Sponsor profile website A", async () => {
    const c = await campaign({ destination: null });
    await submit(c);
    await approve(c);
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe(SITE_A);
  });

  it("removing the campaign link before approval falls back to the profile website", async () => {
    const c = await campaign({ destination: CAMPAIGN_B });
    await submit(c);
    // (Edits go through Sponsor/Admin functions only while a sponsorship is editable; the guard trigger applies the same rules to ANY write, which is what this exercises.)
    await admin.from("sponsorships").update({ destination_url: null }).eq("id", c.sponsorshipId);
    expect((await row(c.sponsorshipId)).destination_url).toBeNull();
    await approve(c);
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe(SITE_A);
  });

  it("neither → no link, and approval still works", async () => {
    const c = await campaign({ destination: null, website: null });
    await submit(c);
    expect((await approve(c)).error).toBeNull();
    expect((await row(c.sponsorshipId)).approved_destination_url).toBeNull();
  });

  it("the SQL rule and the TypeScript resolver agree on every combination", async () => {
    for (const [dest, site] of [[CAMPAIGN_B, SITE_A], [null, SITE_A], [CAMPAIGN_B, null], [null, null]] as const) {
      const c = await campaign({ destination: dest, website: site });
      await submit(c);
      await approve(c);
      expect((await row(c.sponsorshipId)).approved_destination_url, `${dest}/${site}`).toBe(resolveEffectiveSponsorUrl(dest, site).url);
    }
  });

  it("the Sponsor website is NOT copied onto the sponsorship", async () => {
    const c = await campaign({ destination: null });
    await submit(c);
    expect((await row(c.sponsorshipId)).destination_url).toBeNull();
  });
});

describe("approval integrity: a profile edit can't move a live sponsored post", () => {
  it("before approval the fallback follows the profile; the approval then freezes it", async () => {
    const c = await campaign({ destination: null });
    await submit(c);
    await admin.from("sponsors").update({ website: SITE_C }).eq("id", c.sponsor.sponsorId); // before approval: the fallback follows
    await approve(c);
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe(SITE_C);
  });

  it("AFTER approval a profile website change doesn't alter the destination, doesn't void the approval, and doesn't change where the click goes", async () => {
    const c = await live({ destination: null });
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe(SITE_A);
    await admin.from("sponsors").update({ website: SITE_C }).eq("id", c.sponsor.sponsorId);
    const after = await row(c.sponsorshipId);
    expect(after.approved_destination_url).toBe(SITE_A);
    expect(after.review_status).toBe("APPROVED");
    const res = await click(c.sponsorshipId);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${SITE_A}/`);
  });

  it("changing the campaign's OWN link is a material change: the approval is voided, the frozen destination goes with it, and the click path stops until it is re-approved", async () => {
    const c = await live({ destination: CAMPAIGN_B });
    expect((await click(c.sponsorshipId)).status).toBe(302);
    // The database guard voids an approval on a material change from ANY code path (a Sponsor can't edit an approved campaign through its own functions at all).
    await admin.from("sponsorships").update({ destination_url: "https://berria.example.com/other" }).eq("id", c.sponsorshipId);
    const voided = await row(c.sponsorshipId);
    expect(voided).toMatchObject({ review_status: "PENDING", approved_destination_url: null });
    expect((await click(c.sponsorshipId)).status).toBe(404);
    expect((await approve(c)).error).toBeNull(); // re-review: the new effective destination is frozen
    expect((await row(c.sponsorshipId)).approved_destination_url).toBe("https://berria.example.com/other");
  });

  it("the reviewer's approval asserts what they saw: if the profile website changed since, it is refused; a matching one (or '' for none) goes through", async () => {
    const c = await campaign({ destination: null });
    await submit(c);
    await admin.from("sponsors").update({ website: SITE_C }).eq("id", c.sponsor.sponsorId); // changed after the reviewer loaded the page (which showed SITE_A)
    expect((await approve(c, SITE_A)).error?.message).toMatch(/destination_changed/);
    expect((await row(c.sponsorshipId)).review_status).toBe("PENDING");
    expect((await approve(c, SITE_C)).error).toBeNull();
    const none = await campaign({ destination: null, website: null });
    await submit(none);
    expect((await approve(none, "")).error).toBeNull();
  });

  it("the approval snapshot records the effective destination and where it came from", async () => {
    const own = await campaign({ destination: CAMPAIGN_B });
    await submit(own);
    await approve(own);
    const fb = await campaign({ destination: null });
    await submit(fb);
    await approve(fb);
    const snap = async (id: string) => ((await admin.from("sponsorship_approvals").select("snapshot").eq("sponsorship_id", id).single()).data!.snapshot as Row);
    expect(await snap(own.sponsorshipId)).toMatchObject({ destinationUrl: CAMPAIGN_B, effectiveDestinationUrl: CAMPAIGN_B, destinationSource: "CAMPAIGN" });
    expect(await snap(fb.sponsorshipId)).toMatchObject({ destinationUrl: null, effectiveDestinationUrl: SITE_A, destinationSource: "SPONSOR_PROFILE" });
  });
});

describe("the click path: one event per click, none without a link, never an open redirect", () => {
  it("a link exists → 302 to the frozen destination and EXACTLY one CLICK event", async () => {
    const c = await live({ destination: CAMPAIGN_B });
    const before = await clicks(c.sponsorshipId);
    const res = await click(c.sponsorshipId);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(CAMPAIGN_B);
    expect(await clicks(c.sponsorshipId)).toBe(before + 1);
  });

  it("no effective link → 404 and NO click is recorded", async () => {
    const c = await live({ destination: null, website: null });
    const res = await click(c.sponsorshipId);
    expect(res.status).toBe(404);
    expect(await clicks(c.sponsorshipId)).toBe(0);
  });

  it("an un-approved or unpaid sponsorship can't be clicked even if it has a link", async () => {
    const c = await campaign({ destination: CAMPAIGN_B });
    await submit(c);
    expect((await click(c.sponsorshipId)).status).toBe(404);
    expect(await clicks(c.sponsorshipId)).toBe(0);
  });
});

describe("public data: only whether there is a link — never the URL, the Sponsor's contact data or anything private", () => {
  it("a sponsorship with a (fallback) link is public with hasLink; one without is public without", async () => {
    const withLink = await live({ destination: null });
    const without = await live({ destination: null, website: null });
    const map = await loadPublicSponsorships([withLink.postId, without.postId]);
    expect(map.get(withLink.postId)).toMatchObject({ presentedBy: "Berria Bikes", hasLink: true });
    expect(map.get(without.postId)).toMatchObject({ presentedBy: "Berria Bikes", hasLink: false });
    const json = JSON.stringify([...map.values()]);
    expect(json).not.toContain(SITE_A);
    for (const forbidden of ["website", "destination", "contact_email", "contact_phone", "approved_destination"]) expect(json.toLowerCase()).not.toContain(forbidden);
  });
});
