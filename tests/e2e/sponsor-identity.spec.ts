/**
 * Sponsor identity in a real browser: the dedicated /sponsor/signup with REAL email verification (the verification email is read from the local mail
 * catcher), the pending-review state, Super Admin's application queue, MEMBER xor SPONSOR routing in both directions, and the neutral email messages.
 * Local test accounts and a local database only. Nothing here touches production or a real mail provider.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const MAIL = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
const NEUTRAL = "This email can't be used for a Sponsor account. Use a different business email.";
// A 1x1 PNG: a real image the upload route accepts (magic bytes checked, re-encoded server-side).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test.describe.configure({ mode: "serial" });

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-ident-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${Math.floor(Math.random() * 100000)}`, username: `id${label}${Date.now()}${Math.floor(Math.random() * 1000)}`, role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email };
}

async function loginAsMember(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function sponsorLogin(page: Page, email: string, password = PASSWORD) {
  await page.context().clearCookies();
  await page.goto("/sponsor/login");
  await page.getByLabel("Business email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /log in/i }).click();
}

async function fillSignup(page: Page, v: { email: string; brand: string; contact?: string; password?: string }) {
  await page.goto("/sponsor/signup");
  await page.getByLabel("Business email").fill(v.email);
  await page.getByLabel("Password", { exact: true }).fill(v.password ?? PASSWORD);
  await page.getByLabel("Brand or company name").fill(v.brand);
  await page.getByLabel("Contact person's name").fill(v.contact ?? "Pat Contact");
}

/** The verification link Supabase emailed to `to`, read from the local mail catcher (the only way the address can become verified). */
async function verificationLink(to: string): Promise<string> {
  let link: string | null = null;
  await expect
    .poll(
      async () => {
        const list = (await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages?: Array<{ ID: string }> };
        const id = list.messages?.[0]?.ID;
        if (!id) return null;
        const msg = (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as { HTML?: string; Text?: string };
        link = /href="([^"]*\/auth\/v1\/verify[^"]*)"/.exec(msg.HTML ?? "")?.[1]?.replace(/&amp;/g, "&") ?? /(https?:\/\/\S*\/auth\/v1\/verify\S*)/.exec(msg.Text ?? "")?.[1] ?? null;
        return link;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  return link!;
}

async function sponsorRow(email: string) {
  const { data } = await admin.rpc("account_type_for_email", { p_email: email });
  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const user = users.users.find((u) => u.email === email);
  const { data: account } = user ? await admin.from("sponsor_accounts").select("user_id, sponsors(*)").eq("user_id", user.id).maybeSingle() : { data: null };
  return { type: data as string | null, user, sponsor: (Array.isArray(account?.sponsors) ? account?.sponsors[0] : account?.sponsors) as Record<string, any> | null | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test("Sponsor signup: unverified until the emailed link is used, then PENDING_REVIEW with no commercial or social access, and a profile that can be completed", async ({ page }) => {
  test.setTimeout(150_000); // a cold dev server compiles ~10 routes in this one journey
  const email = `e2e-ident-apply-${randomUUID()}@test.local`;
  const brand = `Apply Co ${randomUUID().slice(0, 6)}`;

  await fillSignup(page, { email, brand });
  // Nothing a Member profile has is asked for; nothing about Member vs Sponsor is offered.
  for (const absent of [/username/i, /bio/i, /pronouns/i, /gender/i, /avatar/i, /card/i, /member/i]) await expect(page.getByLabel(absent)).toHaveCount(0);
  await page.getByLabel("Website (optional)").fill("acme.example");
  await page.getByLabel("Country (optional)").fill("Mexico");
  await page.getByLabel("Phone / WhatsApp (optional)").fill("+52 55 1234 5678");
  await page.getByLabel("Logo (optional)").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Apply to sponsor" }).click();
  await expect(page.locator('[data-slot="sponsor-check-email"]')).toBeVisible();

  // The database: a SPONSOR login, a PENDING_REVIEW organization, no member profile, an unverified email.
  const created = await sponsorRow(email);
  expect(created.type).toBe("SPONSOR");
  expect(created.sponsor).toMatchObject({ display_name: brand, status: "PENDING_REVIEW", contact_email: email, contact_name: "Pat Contact", country: "Mexico", website: "https://acme.example/" });
  expect(created.sponsor?.logo_path).toBeTruthy();
  expect(created.user?.email_confirmed_at).toBeFalsy();
  expect((await admin.from("user_profiles").select("id").eq("id", created.user!.id)).data).toEqual([]);

  // Unverified: it cannot sign in, and the message does not say why.
  await sponsorLogin(page, email);
  await expect(page.getByText("Invalid email or password, or your email isn't verified yet.")).toBeVisible();

  // The emailed link verifies the address.
  const link = await verificationLink(email);
  // (Followed from the test process: the auth gateway answers with a redirect to the app's /sponsor/verified page.)
  const verify = await fetch(link, { redirect: "manual" });
  expect([302, 303]).toContain(verify.status);
  expect(verify.headers.get("location") ?? "").toContain("/sponsor/verified");
  await page.goto("/sponsor/verified");
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  expect((await sponsorRow(email)).user?.email_confirmed_at).toBeTruthy();

  // Now it can sign in — to the Sponsor dashboard, under review.
  await sponsorLogin(page, email);
  await expect(page).toHaveURL(/\/sponsor$/);
  await expect(page.locator('[data-slot="sponsor-account-status"]')).toContainText("Application under review");
  await expect(page.getByRole("link", { name: "Available Games" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Browse available Games" })).toHaveCount(0);

  // Pending: no paid inventory, and the Member product is closed to it.
  await page.goto("/sponsor/games");
  await expect(page).toHaveURL(/\/sponsor$/);
  for (const memberPath of ["/feed", "/wallet", "/my-picks", "/notifications", "/profile", "/activity", "/search", "/community/anything", "/admin"]) {
    await page.goto(memberPath);
    await expect(page, memberPath).toHaveURL(/\/sponsor$/);
  }

  // It can complete its profile while under review; the sign-in email is shown, never editable.
  await page.goto("/sponsor/profile");
  await expect(page.locator('[data-slot="sponsor-email"]')).toHaveText(email);
  await page.getByLabel("Contact person's name").fill("Renamed Contact");
  await page.getByLabel("Country").fill("Spain");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  expect((await sponsorRow(email)).sponsor).toMatchObject({ contact_name: "Renamed Contact", country: "Spain" });
  await expect(page.locator('[data-slot="sponsor-logo-preview"]')).toBeVisible();

  // The first verified sign-in recorded the verification once.
  const { data: logs } = await admin.from("audit_logs").select("action").eq("entity_type", "sponsor").eq("entity_id", created.sponsor!.id);
  expect(logs!.filter((l) => l.action === "sponsor.email_verified")).toHaveLength(1);
});

test("email exclusivity is neutral and works both ways: a Member's email and an existing Sponsor's email get the same message, and nothing is created", async ({ page }) => {
  const member = await createMember("excl");
  const before = (await admin.from("sponsors").select("id", { count: "exact", head: true })).count;

  await fillSignup(page, { email: member.email, brand: "Should Not Exist Co" });
  await page.getByRole("button", { name: "Apply to sponsor" }).click();
  await expect(page.getByText(NEUTRAL).first()).toBeVisible();
  expect((await sponsorRow(member.email)).type).toBe("MEMBER");

  // A second application for an email that already holds a CONFIRMED Sponsor account: the identical message.
  const existing = `e2e-ident-exist-${randomUUID()}@test.local`;
  const { data: u } = await admin.auth.admin.createUser({ email: existing, password: PASSWORD, email_confirm: true });
  await admin.rpc("create_sponsor_account", { p_user_id: u.user!.id, p_email: existing, p_brand: "Existing Co", p_contact_name: "X", p_website: null, p_country: null, p_phone: null });
  await fillSignup(page, { email: existing, brand: "Another Brand" });
  await page.getByRole("button", { name: "Apply to sponsor" }).click();
  await expect(page.getByText(NEUTRAL).first()).toBeVisible();
  expect((await admin.from("sponsors").select("id", { count: "exact", head: true })).count).toBe((before ?? 0) + 1); // only the "Existing Co" we made by hand

  // And the other way round: a Sponsor's email cannot become a Member through Member registration.
  await page.goto("/register");
  // (Registration may be closed by the platform setting; the guarantee is enforced in the database either way.)
  const { error } = await admin.from("user_profiles").insert({ id: u.user!.id, display_name: "x", role: "player", is_active: true });
  expect(error).not.toBeNull();
});

test("MEMBER xor SPONSOR routing in both directions", async ({ page }) => {
  const member = await createMember("route");
  const sponsorEmail = `e2e-ident-route-${randomUUID()}@test.local`;
  const { data: u } = await admin.auth.admin.createUser({ email: sponsorEmail, password: PASSWORD, email_confirm: true });
  const { data: org } = await admin.rpc("create_sponsor_account", { p_user_id: u.user!.id, p_email: sponsorEmail, p_brand: `Route Co ${randomUUID().slice(0, 6)}`, p_contact_name: "R", p_website: null, p_country: null, p_phone: null });
  await admin.from("sponsors").update({ status: "ACTIVE" }).eq("id", (Array.isArray(org) ? org[0] : org).id);

  // A Member who signs in on the Sponsor login still lands in the Member product, and cannot enter the Sponsor area.
  await sponsorLogin(page, member.email);
  await expect(page).toHaveURL(/\/feed$/);
  for (const path of ["/sponsor", "/sponsor/games", "/sponsor/profile"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/feed$/);
  }

  // A Sponsor who signs in on the ordinary login lands in the Sponsor area, never in the Member shell.
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(sponsorEmail);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/sponsor$/);
  await expect(page.locator('[data-slot="sponsor-shell"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Discovery" })).toHaveCount(0); // none of the Member shell
  await expect(page.getByRole("link", { name: "Available Games" })).toBeVisible(); // ACTIVE: commercial access
  await page.goto("/feed");
  await expect(page).toHaveURL(/\/sponsor$/);

  // A signed-out visitor to a Sponsor page goes to the SPONSOR login and returns there afterwards.
  await page.context().clearCookies();
  await page.goto("/sponsor/profile");
  await expect(page).toHaveURL(/\/sponsor\/login\?next=%2Fsponsor%2Fprofile$/);
});

test("Super Admin's application queue: review, activate, reject, suspend, disable, restore — each reason is shown to the sponsor, the internal note never is", async ({ page }) => {
  const superUser = await createMember("queue", "super_admin");
  const ordinary = await createMember("queueord");
  await admin.from("user_profiles").update({ role: "admin" }).eq("id", ordinary.id);
  const mk = async (label: string) => {
    const email = `e2e-ident-q${label}-${randomUUID()}@test.local`;
    const { data: u } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    const brand = `Queue ${label} ${randomUUID().slice(0, 6)}`;
    const { data: org } = await admin.rpc("create_sponsor_account", { p_user_id: u.user!.id, p_email: email, p_brand: brand, p_contact_name: "Queue Contact", p_website: null, p_country: "Chile", p_phone: null });
    return { email, brand, id: (Array.isArray(org) ? org[0] : org).id as string };
  };
  const approve = await mk("a");
  const reject = await mk("r");

  // An ordinary admin is not a Super Admin: the queue is closed to them.
  await loginAsMember(page, ordinary.email);
  await page.goto("/admin/sponsorship/sponsors");
  await expect(page).toHaveURL(/\/feed$/);

  await loginAsMember(page, superUser.email);
  await page.goto("/admin/sponsorship/sponsors");
  await expect(page.locator('[data-slot="sponsor-applications-count"]')).toContainText(/application/);
  const cardA = page.locator("li[data-sponsor-id]").filter({ hasText: approve.brand });
  await expect(cardA.getByText("Pending review")).toBeVisible();
  await expect(cardA.getByText(approve.email)).toBeVisible();
  await expect(cardA.getByText("Queue Contact")).toBeVisible();

  // Rejecting needs a reason.
  const cardR = page.locator("li[data-sponsor-id]").filter({ hasText: reject.brand });
  await cardR.getByRole("button", { name: "Reject" }).click();
  await expect(cardR.getByText(/Give a reason/)).toBeVisible();
  await cardR.getByLabel(`Reason for ${reject.brand}`).fill("Not a fit for Brohda");
  await cardR.getByLabel(`Internal note for ${reject.brand}`).fill("INTERNAL-ONLY-NOTE");
  await cardR.getByRole("button", { name: "Reject" }).click();
  await expect(cardR.locator('[data-slot="sponsor-account-status"]')).toHaveText("Rejected");

  await cardA.getByRole("button", { name: "Activate" }).click();
  await expect(cardA.locator('[data-slot="sponsor-account-status"]')).toHaveText("Active");
  expect((await sponsorRow(approve.email)).sponsor?.status).toBe("ACTIVE");

  // The rejected sponsor can sign in and sees the reason — not the internal note — and has no commercial access.
  await sponsorLogin(page, reject.email);
  await expect(page).toHaveURL(/\/sponsor$/);
  await expect(page.locator('[data-slot="sponsor-account-status"]')).toContainText("Application not approved");
  await expect(page.locator('[data-slot="sponsor-account-status"]')).toContainText("Not a fit for Brohda");
  await expect(page.getByText("INTERNAL-ONLY-NOTE")).toHaveCount(0);
  await page.goto("/sponsor/games");
  await expect(page).toHaveURL(/\/sponsor$/);

  // The approved sponsor has commercial access; suspending takes it away at once; restoring brings it back.
  await sponsorLogin(page, approve.email);
  await expect(page.getByRole("link", { name: "Available Games" })).toBeVisible();
  await loginAsMember(page, superUser.email);
  await page.goto("/admin/sponsorship/sponsors");
  const again = page.locator("li[data-sponsor-id]").filter({ hasText: approve.brand });
  await again.getByLabel(`Reason for ${approve.brand}`).fill("Payment dispute");
  await again.getByRole("button", { name: "Suspend" }).click();
  await expect(again.locator('[data-slot="sponsor-account-status"]')).toHaveText("Suspended");
  await sponsorLogin(page, approve.email);
  await expect(page.locator('[data-slot="sponsor-account-status"]')).toContainText("Account suspended");
  await expect(page.getByRole("link", { name: "Available Games" })).toHaveCount(0);
  await page.goto("/sponsor/games");
  await expect(page).toHaveURL(/\/sponsor$/);

  await loginAsMember(page, superUser.email);
  await page.goto("/admin/sponsorship/sponsors");
  await page.locator("li[data-sponsor-id]").filter({ hasText: approve.brand }).getByRole("button", { name: "Restore" }).click();
  await expect(page.locator("li[data-sponsor-id]").filter({ hasText: approve.brand }).locator('[data-slot="sponsor-account-status"]')).toHaveText("Active");
  await admin.from("user_profiles").update({ role: "player" }).in("id", [superUser.id, ordinary.id]);
});
