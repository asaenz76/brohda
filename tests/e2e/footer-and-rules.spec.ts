/**
 * E2E coverage for the shared page footer (Rules, Terms, Privacy, Sponsorship, copyright)
 * at the very bottom of every page — logged out and logged in, at every width —
 * and for the Rules page: one canonical explanation of how Brohda works,
 * readable without an account (public frame) and inside the app shell when
 * signed in, quoting the live policy values. Needs no seeded Games.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { describeLockWindow, describePickDeadline, describeStakeLimits, formatFeePercent } from "../../lib/rules/format";

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
  await expect(links, label).toHaveText(["Rules", "Terms", "Privacy", "Sponsorship"]);
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

test.describe("Rules page", () => {
  const SECTION_HEADINGS = [
    "The basics",
    "Game Posts",
    "Picks",
    "When Picks lock",
    "Call BS",
    "Your prediction record",
    "Money",
    "Results and grading",
    "When a game can't be decided",
    "Comments and conduct",
    "Where these rules come from",
  ];

  test("logged out: no account needed, reachable from the footer beside Terms and Privacy, in the public frame with one h1", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("contentinfo").getByRole("link", { name: "Rules" }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page).toHaveTitle("Brohda Rules");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Brohda Rules" })).toBeVisible();
    await expect(page.getByRole("article").getByRole("heading", { level: 2 })).toHaveText(SECTION_HEADINGS);
    // The public frame: the two ways in, no app shell.
    await expect(page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });

  test("logged in: the same Rules inside the app shell — Rules is a quiet secondary entry, never a primary destination", async ({ page }) => {
    await login(page);
    await page.getByRole("contentinfo").getByRole("link", { name: "Rules" }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
    await expect(page.getByRole("article").getByRole("heading", { level: 2 })).toHaveText(SECTION_HEADINGS); // identical content to the public page (the rail has its own headings)
    const rail = page.getByRole("complementary", { name: "Navigation" }).getByRole("navigation", { name: "Primary" });
    await expect(rail.locator('a[aria-current="page"]')).toContainText("Rules");
    const hrefs = await rail.getByRole("link").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(hrefs.slice(0, 5)).toEqual(["/feed", "/discovery", "/notifications", "/search", "/profile"]); // Rules isn't among the primary five
    expect(hrefs.indexOf("/rules")).toBeGreaterThan(hrefs.indexOf("/profile/edit")); // it sits with Settings, below Wallet
    // A readable article width inside the centre column.
    const width = (await page.getByRole("article").boundingBox())!.width;
    expect(width).toBeLessThanOrEqual(660);
  });

  test("quotes the LIVE policy values — cutoff, fee, stake limits — read from the settings, not from page copy", async ({ page }) => {
    const { data } = await admin
      .from("platform_settings")
      .select("pick_lock_minutes_before_kickoff, p2p_fee_bps, monetary_p2p_min_stake_cents, monetary_p2p_max_stake_cents")
      .eq("id", true)
      .single();
    const lock = describeLockWindow(data!.pick_lock_minutes_before_kickoff);
    const fee = formatFeePercent(data!.p2p_fee_bps);
    const limits = describeStakeLimits(Number(data!.monetary_p2p_min_stake_cents), Number(data!.monetary_p2p_max_stake_cents));
    await page.goto("/rules");
    const main = page.getByRole("main");
    await expect(main).toContainText(`Picks lock ${lock}`);
    await expect(main).toContainText(`You can make or change your Pick ${describePickDeadline(data!.pick_lock_minutes_before_kickoff)}.`);
    // One cutoff for Picks, Call BS and money; no separate Game/Market lock time is promised.
    await expect(main).toContainText("closes at the same time");
    await expect(main).not.toContainText(/more than once|Game and Markets lock|5 minutes/i);
    await expect(main).toContainText(`The fee is currently ${fee}.`);
    await expect(main).toContainText(`Each offer must be ${limits}.`);
  });

  test("describes how Brohda really works: Brohda publishes every Game Post, Call BS and money are separate, grading ignores comments", async ({ page }) => {
    await page.goto("/rules");
    const main = page.getByRole("main");
    await expect(main).toContainText("Every Game Post is created by Brohda. Members can't create, edit or remove one.");
    await expect(main).toContainText("Members don't publish games or Markets.");
    await expect(main).toContainText("only one accepted Call BS per Market");
    await expect(main).toContainText("Accepting locks both Picks right away");
    await expect(main).toContainText("Money is optional");
    await expect(main).toContainText("correct ÷ (correct + incorrect)");
    await expect(main).toContainText("Comments, community sentiment and what most people picked don't affect grading.");
    await expect(main).toContainText("No fee is taken and nothing moves.");
    // No Pool-era copy, no legal boilerplate.
    const text = await main.innerText();
    expect(text).not.toMatch(/\bpools?\b|leaderboard|analytics|indemnif|governing law|arbitration/i);
  });

  test("is read-only: no buttons, forms or inputs anywhere in the article, and nothing to mutate", async ({ page }) => {
    await page.goto("/rules");
    await expect(page.getByRole("article").locator("button, form, input, textarea, select")).toHaveCount(0);
    await login(page);
    await page.goto("/rules");
    await expect(page.getByRole("article").locator("button, form, input, textarea, select")).toHaveCount(0);
  });

  test("Terms and Privacy stay separate documents (with the same public header as Rules), and the old How it works address now lands on Rules", async ({ page }) => {
    for (const [path, heading] of [["/terms", "Terms of Service"], ["/privacy", "Privacy Policy"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(/^Effective /)).toBeVisible();
      await expect(page.getByRole("link", { name: "support@brohda.com" }).last()).toBeVisible();
      await expect(page.getByRole("contentinfo").getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/rules");
    }
    const response = await page.request.get("/how-it-works", { maxRedirects: 0 });
    expect(response.status()).toBe(308);
    expect(response.headers()["location"]).toMatch(/\/rules$/);
    await page.goto("/how-it-works");
    await expect(page).toHaveURL(/\/rules$/);
  });

  for (const width of [375, 320]) {
    test(`reads cleanly at ${width}px, logged out and logged in — no table, no sideways scroll`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await ctx.newPage();
      await page.goto("/rules");
      await expect(page.getByRole("heading", { level: 1, name: "Brohda Rules" })).toBeVisible();
      await expectNoHorizontalScroll(page, `rules logged out ${width}`);
      expect(await page.locator("table").count()).toBe(0);
      await login(page);
      await page.goto("/rules");
      await expect(page.getByRole("heading", { level: 1, name: "Rules" })).toBeVisible();
      await expectNoHorizontalScroll(page, `rules logged in ${width}`);
      // The phone bottom bar never covers the end of the page: the footer is reachable.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.getByRole("contentinfo")).toBeInViewport();
      await ctx.close();
    });
  }

  test("375 menus link to Rules: the logged-out hamburger and the signed-in Menu sheet", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Rules" }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await login(page);
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Rules" }).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByTestId("auth-bottom-nav")).toBeVisible(); // still inside the app shell
    await ctx.close();
  });
});
