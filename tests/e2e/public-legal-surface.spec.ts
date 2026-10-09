/**
 * The public surface around Sponsors: ONE public header on Rules, Terms, Privacy, the new Sponsorship page and the Sponsor Terms; Sponsorship in the shared
 * footer; the Sponsorship page's call to action opening the DEDICATED Sponsor signup (never Member registration); the Sponsor Terms shown as a DRAFT that
 * nobody is asked to accept; and the account-aware header for signed-in visitors. Local test accounts only; it never toggles a platform setting (the
 * capability-off behavior of /sponsorship is covered in sponsorship-flow.spec.ts, which owns the serial settings project).
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
let memberEmail = "";
let sponsorEmail = "";

const PAGES = [
  ["/rules", "Brohda Rules"],
  ["/terms", "Terms of Service"],
  ["/privacy", "Privacy Policy"],
  ["/sponsorship", "Sponsor the game conversation."],
  ["/sponsor/terms", "Sponsor Terms"],
] as const;

test.beforeAll(async () => {
  memberEmail = `pub-member-${suffix}@test.local`;
  const m = await admin.auth.admin.createUser({ email: memberEmail, password: PASSWORD, email_confirm: true });
  await admin.from("user_profiles").insert({ id: m.data.user!.id, display_name: "Public Viewer", username: `pubv${suffix}`, role: "player", is_active: true });
  sponsorEmail = `pub-sponsor-${suffix}@test.local`;
  const s = await admin.auth.admin.createUser({ email: sponsorEmail, password: PASSWORD, email_confirm: true });
  const { data: org } = await admin.rpc("create_sponsor_account", { p_user_id: s.data.user!.id, p_email: sponsorEmail, p_brand: `Public Co ${suffix}`, p_contact_name: "P", p_website: null, p_country: null, p_phone: null });
  await admin.from("sponsors").update({ status: "ACTIVE" }).eq("id", (Array.isArray(org) ? org[0] : org).id);
});

async function noSideScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: scrolls sideways`).toBeLessThanOrEqual(iw);
}

test.describe("one public header, everywhere", () => {
  for (const [path, heading] of PAGES) {
    test(`${path}: logo, Log in, Create account, one h1, the shared footer — and no old Back link`, async ({ page }) => {
      await page.goto(path);
      const header = page.getByRole("banner");
      await expect(header.getByRole("link", { name: "brohda." })).toHaveAttribute("href", "/");
      const account = header.getByRole("navigation", { name: "Account" });
      await expect(account.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
      await expect(account.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      await expect(page.getByText(/Back to brohda/)).toHaveCount(0);
      const footer = page.getByRole("contentinfo");
      await expect(footer.getByRole("navigation", { name: "About and legal" }).getByRole("link")).toHaveText(["Rules", "Terms", "Privacy", "Sponsorship"]);
    });
  }

  for (const width of [320, 375, 768, 1280]) {
    test(`readable at ${width}px: nothing overflows, the header and the call to action stay in view`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      for (const [path] of PAGES) {
        await page.goto(path);
        await noSideScroll(page, `${path} @${width}`);
        await expect(page.getByRole("banner").getByRole("link", { name: "Create account" })).toBeVisible();
      }
      await page.goto("/sponsorship");
      await expect(page.getByRole("link", { name: "Become a Sponsor" }).first()).toBeVisible();
      await ctx.close();
    });
  }
});

test.describe("Sponsorship in the footer, and the public Sponsorship page", () => {
  test("the footer link opens /sponsorship from every public page, and on the app shell for a signed-in Member", async ({ page }) => {
    await page.goto("/rules");
    await page.getByRole("contentinfo").getByRole("link", { name: "Sponsorship" }).click();
    await expect(page).toHaveURL(/\/sponsorship$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sponsor the game conversation." })).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Sponsorship" })).toHaveAttribute("href", "/sponsorship");
  });

  test("explains the product honestly: how it works, what sponsors get and do not get, always labeled; no sportsbook language, no analytics promise", async ({ page }) => {
    await page.goto("/sponsorship");
    const main = page.getByRole("main");
    for (const text of ["Create a Sponsor account.", "Brohda reviews and approves your Sponsor account.", "Choose an available Game.", "Submit your sponsorship and pay.", "Brohda reviews the campaign.", "Paid and approved campaigns run during their scheduled window."]) await expect(main.getByText(text)).toBeVisible();
    await expect(main.getByText(/Any control over Markets or Picks/)).toBeVisible();
    await expect(main.getByText(/Access to individual brohda\. Members or their data/)).toBeVisible();
    await expect(main.getByText(/both payment and Brohda's approval/)).toBeVisible();
    await expect(main.getByText(/clearly labeled|Always clearly labeled/).first()).toBeVisible();
    const text = (await main.innerText()).toLowerCase();
    for (const banned of ["odds", "sportsbook", "wager", "gambl", "bet "]) expect(text, banned).not.toContain(banned);
    expect(text).toContain("not available yet"); // reporting is planned, not claimed
  });

  test("the call to action is the DEDICATED Sponsor signup — never Member registration — and Sponsor log in is the Sponsor login", async ({ page }) => {
    await page.goto("/sponsorship");
    const ctas = page.getByRole("link", { name: "Become a Sponsor" });
    await expect(ctas).toHaveCount(2);
    for (const cta of await ctas.all()) {
      await expect(cta).toHaveAttribute("href", "/sponsor/signup");
      expect(await cta.getAttribute("href")).not.toContain("register");
    }
    await expect(page.getByRole("link", { name: "Sponsor log in" })).toHaveAttribute("href", "/sponsor/login");
    // Member registration is the header's "Create account" and nothing in the page body points at it.
    await expect(page.getByRole("main").locator('a[href^="/register"]')).toHaveCount(0);
    await ctas.first().click();
    await expect(page).toHaveURL(/\/sponsor\/signup$/);
    await expect(page.getByRole("heading", { name: "Become a Sponsor" })).toBeVisible();
    for (const memberField of [/username/i, /display name/i]) await expect(page.getByLabel(memberField)).toHaveCount(0);
  });

  test("the call to action is reachable and operable by keyboard, with a visible focus", async ({ page }) => {
    await page.goto("/sponsorship");
    let focused = "";
    for (let i = 0; i < 20 && focused !== "Become a Sponsor"; i++) {
      await page.keyboard.press("Tab");
      focused = (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "")) as string;
    }
    expect(focused).toBe("Become a Sponsor");
    expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible"))).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sponsor\/signup$/);
  });
});

test.describe("Sponsor Terms are a visible DRAFT that binds nobody", () => {
  test("public, marked DRAFT — OWNER/COUNSEL REVIEW REQUIRED, no accept button, and the signup form asks for no acceptance", async ({ page }) => {
    await page.goto("/sponsor/terms");
    await expect(page.getByRole("heading", { level: 1, name: "Sponsor Terms" })).toBeVisible();
    await expect(page.locator('[data-slot="draft-banner"]').first()).toContainText("DRAFT — OWNER/COUNSEL REVIEW REQUIRED");
    await expect(page.getByText(/not final|has not been reviewed or approved by counsel/).first()).toBeVisible();
    await expect(page.getByText(/Effective/)).toContainText("draft, not yet in effect");
    await expect(page.locator('[data-slot="accept-sponsor-terms"]')).toHaveCount(0);
    for (const subject of ["Sponsor account and eligibility", "Payment", "Refunds", "Sponsor-run promotions", "Member data"]) await expect(page.getByRole("heading", { name: new RegExp(subject) }).first()).toBeVisible();
    await page.goto("/sponsor/signup");
    await expect(page.getByLabel(/Sponsor Terms/)).toHaveCount(0); // a draft is never offered for acceptance
    await page.goto("/sponsorship");
    await expect(page.getByRole("link", { name: /Sponsor Terms \(draft\)/ })).toHaveAttribute("href", "/sponsor/terms");
  });

  test("the Privacy Policy now describes Sponsor data, marked as a draft section, and states Sponsors get no Member data", async ({ page }) => {
    await page.goto("/privacy");
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: /Sponsor accounts and sponsorships/ }) });
    await expect(section).toContainText("DRAFT — pending owner and counsel review");
    for (const item of [/business email/i, /contact person/i, /phone or WhatsApp/i, /logo/i, /review notes/i, /never receive information about individual Members/i, /not public/i]) await expect(section).toContainText(item);
  });
});

test.describe("the header knows who is signed in", () => {
  async function loginMember(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(memberEmail);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/feed$/);
  }

  test("a signed-in Member on Terms/Privacy/Sponsorship sees 'Open brohda.' instead of Log in / Create account, and never a Sponsor link", async ({ page }) => {
    await loginMember(page);
    for (const path of ["/terms", "/privacy", "/sponsorship", "/sponsor/terms"]) {
      await page.goto(path);
      const account = page.getByRole("banner").getByRole("navigation", { name: "Account" });
      await expect(account.getByRole("link", { name: "Open brohda." })).toHaveAttribute("href", "/feed");
      await expect(account.getByRole("link", { name: "Log in" })).toHaveCount(0);
      await expect(account.getByRole("link", { name: "Create account" })).toHaveCount(0);
      await expect(account.getByRole("link", { name: /Sponsor/ })).toHaveCount(0);
    }
    // Rules keeps its established behavior: a Member gets the app shell.
    await page.goto("/rules");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("a signed-in Sponsor sees 'Sponsor dashboard' on every public page, and reaches the Sponsor Terms from its own area", async ({ page }) => {
    await page.goto("/sponsor/login");
    await page.getByLabel("Business email").fill(sponsorEmail);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: /log in/i }).click();
    await expect(page).toHaveURL(/\/sponsor$/);
    await page.getByRole("navigation", { name: "Sponsor legal" }).getByRole("link", { name: "Sponsor Terms" }).click();
    await expect(page).toHaveURL(/\/sponsor\/terms$/);
    for (const path of ["/rules", "/terms", "/privacy", "/sponsorship", "/sponsor/terms"]) {
      await page.goto(path);
      const account = page.getByRole("banner").getByRole("navigation", { name: "Account" });
      await expect(account.getByRole("link", { name: "Sponsor dashboard" })).toHaveAttribute("href", "/sponsor");
      await expect(account.getByRole("link", { name: "Log in" })).toHaveCount(0);
      await expect(account.getByRole("link", { name: "Open brohda." })).toHaveCount(0);
    }
  });
});
