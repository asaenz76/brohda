/**
 * Sponsor signup once Sponsor Terms are APPROVED: acceptance is required, the SERVER's approved version is what gets stored (nothing the browser sends can
 * change it), and a refused signup creates nothing. The approved document is injected here (the shipped registry is still a draft) — the real server
 * action, the real database and the real Auth service do the rest.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";

const APPROVED = { key: "sponsor_terms", title: "Sponsor Terms", version: "2026-12-01", effectiveDate: "December 1, 2026", status: "APPROVED" as const, href: "/sponsor/terms" };

vi.mock("@/lib/sponsor/terms", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/sponsor/terms")>()), CURRENT_SPONSOR_TERMS: { key: "sponsor_terms", title: "Sponsor Terms", version: "2026-12-01", effectiveDate: "December 1, 2026", status: "APPROVED", href: "/sponsor/terms" } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (await import("./helpers/test-env")).getTestAnonClient() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000", "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1` }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const admin = getTestAdminClient();
let signup: typeof import("@/lib/actions/sponsor-account").sponsorSignupAction;

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  process.env.APP_URL = "http://localhost:3000";
  signup = (await import("@/lib/actions/sponsor-account")).sponsorSignupAction;
});
afterAll(() => undefined);

function form(email: string, extra: Record<string, string> = {}) {
  const f = new FormData();
  f.set("email", email);
  f.set("password", "a-long-password-123");
  f.set("brandName", `Terms Co ${randomUUID().slice(0, 6)}`);
  f.set("contactName", "Pat Contact");
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}
const typeFor = async (email: string) => (await admin.rpc("account_type_for_email", { p_email: email })).data as string | null;

describe("Sponsor signup with APPROVED Sponsor Terms", () => {
  it("D. cannot register without the acceptance — nothing is created", async () => {
    const email = `terms-none-${randomUUID()}@test.local`;
    const r = await signup({ error: null }, form(email));
    expect(r.error).toBe("Check the highlighted fields.");
    expect(r.fieldErrors?.acceptedTerms).toMatch(/Accept the Sponsor Terms/);
    expect(await typeFor(email)).toBeNull();
    // The browser's own "off" values never count either.
    for (const off of ["", "off", "false", "0", "true", "yes"]) {
      const e2 = `terms-off-${randomUUID()}@test.local`;
      const rr = await signup({ error: null }, form(e2, { acceptedTerms: off }));
      expect(rr.fieldErrors?.acceptedTerms, off).toBeTruthy();
      expect(await typeFor(e2)).toBeNull();
    }
  });

  it("E/F. with the acceptance, the account is created and the SERVER's approved version is stored — a forged version in the request changes nothing", async () => {
    const email = `terms-ok-${randomUUID()}@test.local`;
    const r = await signup({ error: null }, form(email, { acceptedTerms: "on", termsVersion: "1999-01-01", version: "DRAFT-1", document_key: "forged", acceptedVersion: "x" }));
    expect(r.error).toBeNull();
    expect(r.sent).toBe(true);
    const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const user = users.users.find((u) => u.email === email)!;
    expect(user).toBeTruthy();
    const { data: acceptances } = await admin.from("sponsor_terms_acceptances").select("*").eq("user_id", user.id);
    expect(acceptances).toHaveLength(1);
    expect(acceptances![0]).toMatchObject({ document_key: APPROVED.key, version: APPROVED.version, source: "signup" });
    expect(acceptances![0].sponsor_id).toBeTruthy();
    expect(acceptances![0].accepted_at).toBeTruthy();
    // It is a SPONSOR with no member profile, as before.
    expect(await typeFor(email)).toBe("SPONSOR");
    expect((await admin.from("user_profiles").select("id").eq("id", user.id)).data).toEqual([]);
    // Immutable.
    expect((await admin.from("sponsor_terms_acceptances").update({ version: "forged" }).eq("user_id", user.id)).error?.message ?? "").toContain("immutable");
  });

  it("a neutral refusal (the email belongs to a Member) records no acceptance", async () => {
    const memberEmail = `terms-member-${randomUUID()}@test.local`;
    const { data } = await admin.auth.admin.createUser({ email: memberEmail, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: data.user!.id, display_name: "m", role: "player", is_active: true });
    const r = await signup({ error: null }, form(memberEmail, { acceptedTerms: "on" }));
    expect(r.error).toBe("This email can't be used for a Sponsor account. Use a different business email.");
    expect((await admin.from("sponsor_terms_acceptances").select("id").eq("user_id", data.user!.id)).data).toEqual([]);
    expect(getTestAnonClient()).toBeTruthy();
  });
});
