/**
 * E2E coverage for the shared page footer (How it works, Terms, Privacy,
 * copyright) at the very bottom of every page — logged out and logged in, at
 * every width — and for the public "How Brohda works" page that lives beside
 * the Terms and the Privacy policy. Needs no seeded Games: the footer and the
 * explainer don't depend on any.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const userIds: string[] = [];
let email = "";

test.beforeAll(async () => {
  email = `footer-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: "Footer Viewer", username: `footer${suffix}`, role: "player", is_active: true });
  userIds.push(data.user.id);
});
test.afterAll(async () => {
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, `${label}: page scrolls horizontally`).toBeLessThanOrEqual(iw);
}

/** The footer is the last thing on the page and nothing (e.g. the fixed bottom bar) covers it once scrolled to the end. */
async function expectFooterAtBottom(page: Page, label: string) {
  const footer = page.getByRole("contentinfo");
  await expect(footer, label).toBeVisible();
  const links = footer.getByRole("navigation", { name: "About and legal" }).getByRole("link");
  await expect(links, label).toHaveText(["How it works", "Terms", "Privacy"]);
  await expect(footer, label).toContainText(`© ${new Date().getFullYear()} Brohda`);
  // Scroll to the true end and check the footer is fully on screen there. The document can still be growing (crests loading,
  // a long timeline settling), so scroll again and re-measure until it holds, in one read each time.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return page.evaluate(() => {
          const foot = document.querySelector("footer")!.getBoundingClientRect();
          const atEnd = Math.round(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 2;
          return atEnd && foot.bottom <= window.innerHeight + 1;
        });
      },
      { message: `${label}: footer is within the screen at the end of the page` },
    )
    .toBe(true);
  const box = (await footer.boundingBox())!;
  // After all page content: the footer starts below the main column's end (measured in one go, so a growing page can't skew it).
  const gap = await page.evaluate(() => {
    const main = document.querySelector("main")!.getBoundingClientRect();
    const foot = document.querySelector("footer")!.getBoundingClientRect();
    return foot.top - main.bottom;
  });
  expect(gap, `${label}: footer sits below the main column`).toBeGreaterThanOrEqual(-1);
  // The fixed bottom bar (phones) never overlaps the footer.
  for (const id of ["public-bottom-bar", "auth-bottom-nav"]) {
    const bar = page.getByTestId(id);
    if (await bar.isVisible().catch(() => false)) {
      const barBox = (await bar.boundingBox())!;
      expect(box.y + box.height, `${label}: footer is not under the ${id}`).toBeLessThanOrEqual(barBox.y + 1);
    }
  }
}

for (const [label, width, height] of [["1280", 1280, 900], ["768", 768, 1024], ["375", 375, 812], ["320", 320, 568]] as const) {
  test.describe(`Footer — ${label}px`, () => {
    test.use({ viewport: { width, height } });

    test("logged out: the footer is the bottom of the front door", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("main")).toBeVisible();
      await expectFooterAtBottom(page, `logged out ${label}`);
      await expectNoHorizontalScroll(page, `logged out ${label}`);
    });

    test("logged in: the same footer ends Home, Discovery and a Post's page", async ({ page }) => {
      await login(page);
      await expectFooterAtBottom(page, `logged in feed ${label}`);
      await page.goto("/discovery");
      await expectFooterAtBottom(page, `logged in discovery ${label}`);
      await page.goto("/notifications");
      await expectFooterAtBottom(page, `logged in notifications ${label}`);
      await expectNoHorizontalScroll(page, `logged in ${label}`);
    });
  });
}

test.describe("How Brohda works", () => {
  test("logged out: reachable from the footer, alongside Terms and Privacy, with the whole explanation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await expect(page).toHaveTitle(/How brohda\. works/);
    await expect(page.getByRole("heading", { level: 1, name: "How Brohda works" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["The games", "How to play", "Your record", "When a game doesn't finish", "Money"]);
    await expect(page.getByRole("listitem")).toHaveCount(5);
    for (const step of ["Pick a side.", "Change your mind, until it locks.", "Talk shit.", "Call BS.", "See who was right."]) {
      await expect(page.getByRole("listitem").filter({ hasText: step })).toBeVisible();
    }
    // The page carries the same footer, so Terms and Privacy are one click away, and it links back home.
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    await expect(page.getByRole("link", { name: "← Back to brohda." })).toHaveAttribute("href", "/");
  });

  test("it makes no promises about money and no composer or account form appears on it", async ({ page }) => {
    await page.goto("/how-it-works");
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/\b(bet|bets|betting|wager|stake|payout|winnings|jackpot|odds)\b/i);
    expect(await page.locator("textarea, form, input").count()).toBe(0);
  });

  test("logged in: the same public page opens without the app shell, and the footer leads on to Terms and Privacy", async ({ page }) => {
    await login(page);
    await page.getByRole("contentinfo").getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await expect(page.getByRole("heading", { level: 1, name: "How Brohda works" })).toBeVisible();
    await page.getByRole("contentinfo").getByRole("link", { name: "Privacy" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    await page.goBack();
    await page.getByRole("contentinfo").getByRole("link", { name: "Terms" }).click();
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page.getByText("Effective July 22, 2026")).toBeVisible();
  });

  test("the Terms and Privacy pages keep their own chrome (effective date, contact) and gain the footer", async ({ page }) => {
    for (const [path, heading] of [["/terms", "Terms of Service"], ["/privacy", "Privacy Policy"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(/^Effective /)).toBeVisible();
      await expect(page.getByRole("link", { name: "support@brohda.com" }).last()).toBeVisible(); // the closing contact line (the policy text may also mention it)
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/how-it-works");
    }
  });

  for (const width of [375, 320]) {
    test(`reads cleanly at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/how-it-works");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoHorizontalScroll(page, `how-it-works ${width}`);
    });
  }

  test("375 menus link to it: the logged-out hamburger and the signed-in Menu sheet", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await login(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/\/how-it-works$/);
    await ctx.close();
  });
});
