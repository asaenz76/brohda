/**
 * Rules, Terms and Privacy in a real browser, with Member monetary P2P ON and OFF. Money OFF means NO Member-money language on any of the three pages — even though the spec
 * deliberately puts a wallet ledger entry on file (financial records are kept internally; they have no influence on what is published). The server output itself is checked
 * (the raw HTML), so there is no flash of money copy that script later hides. It flips the platform_settings singleton live (no deploy, no source edit), so it runs in its own
 * serial project.
 */
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const users: string[] = [];

async function setMoney(enabled: boolean) {
  const { error } = await admin.from("platform_settings").update({ monetary_p2p_enabled: enabled }).eq("id", true);
  expect(error).toBeNull();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const { data } = await admin.auth.admin.createUser({ email: `legalmoney-${randomUUID()}@test.local`, password: "e2e-password-123", email_confirm: true });
  await admin.from("user_profiles").insert({ id: data.user!.id, display_name: "Ledger holder", username: `lm${Date.now()}`, role: "player", is_active: true });
  users.push(data.user!.id);
  const { error } = await admin.rpc("apply_wallet_transaction", { p_account_type: "user", p_user_id: data.user!.id, p_type: "manual_deposit", p_direction: "credit", p_amount: 500, p_admin_id: null, p_reason: "e2e", p_idempotency_key: randomUUID() });
  expect(error).toBeNull();
});

test.afterAll(async () => {
  await setMoney(false);
  for (const id of users) await admin.auth.admin.deleteUser(id);
});

test("money ON: Rules, Terms and Privacy describe the optional money layer", async ({ page }) => {
  await setMoney(true);
  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "Money", exact: true })).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "5. Service fee" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "3. Deposits and withdrawals happen outside the App" })).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByText("Money is private to the people involved.")).toBeVisible();
});

// Targeted phrases that exist ONLY in the Member-money copy. Checked against the RAW server HTML (so nothing money-related is sent to the browser to be hidden).
const MONEY_MARKERS = [
  "Retained wallet records",
  "Financial records we still hold",
  "Service fee",
  "Deposits and withdrawals happen outside the App",
  "Money is private to the people involved",
  "party to any wager, bet, or contest between members",
  "optional money Position",
  "may add funds",
  "commits part of their wallet balance",
  "optional money between members",
  "any dispute over money you sent or received off-platform",
  "payment app login credentials",
];
const html = async (page: import("@playwright/test").Page, path: string) => (await page.request.get(path)).text();

test("money OFF (a wallet ledger entry is on file): no Member-money language on /terms, /rules or /privacy — in the page AND in the raw server HTML — and Call BS reads as free", async ({ page }) => {
  await setMoney(false);
  for (const path of ["/terms", "/rules", "/privacy"]) {
    const raw = await html(page, path);
    for (const marker of MONEY_MARKERS) expect(raw, `${path}: ${marker}`).not.toContain(marker);
  }

  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "Money", exact: true })).toHaveCount(0);
  const rules = await page.locator("body").innerText();
  expect(rules).not.toMatch(/offer money|money Position|wallet|stake|fee\b/i);
  expect(rules).toContain("Call BS is a free, head-to-head challenge between two people who picked opposite sides of the same Market.");

  await page.goto("/terms");
  const terms = await page.locator("body").innerText();
  await expect(page.getByRole("heading", { name: /Service fee|Deposits and withdrawals|Retained wallet records/ })).toHaveCount(0);
  expect(terms).not.toMatch(/wallet|wager|bookmaker|gambling|escrow|\bPositions?\b|deposit|withdraw|settle|\bbets?\b|stake/i);

  await page.goto("/privacy");
  const privacy = await page.locator("body").innerText();
  await expect(page.getByRole("heading", { name: /Financial records we still hold/ })).toHaveCount(0);
  const memberSections = await page.locator("section").evaluateAll((els) => els.filter((el) => !/Sponsor accounts and sponsorships/.test(el.querySelector("h2")?.textContent ?? "")).map((el) => el.textContent ?? ""));
  expect(memberSections.join(" ")).not.toMatch(/wallet|withdraw|deposit|ledger|balance|\bPositions?\b|payment app|payout|settle/i);
  expect(privacy).toContain("Sponsor accounts and sponsorships"); // the Sponsor section is a separate domain and stays

  for (const out of [rules, terms, privacy]) expect(out).not.toMatch(/coming soon|money[^.]{0,80}(unavailable|switched off|disabled|paused)/i);
});

test("LIVE TOGGLE with no deploy: OFF hides the money copy, ON shows the approved money sections, OFF hides it again", async ({ page }) => {
  const present = async () => {
    const [terms, rules, privacy] = await Promise.all([html(page, "/terms"), html(page, "/rules"), html(page, "/privacy")]);
    return { terms: terms.includes("Service fee") && terms.includes("Deposits and withdrawals"), rules: rules.includes("Money") && rules.includes("optional money between members"), privacy: privacy.includes("Money is private to the people involved") };
  };
  await setMoney(false);
  expect(await present()).toEqual({ terms: false, rules: false, privacy: false });
  await setMoney(true);
  expect(await present()).toEqual({ terms: true, rules: true, privacy: true });
  await setMoney(false);
  expect(await present()).toEqual({ terms: false, rules: false, privacy: false });
});

test("the Rules <meta> description follows the same state (no stale money text in search/preview metadata)", async ({ page }) => {
  const description = async () => /<meta name="description" content="([^"]*)"/.exec(await html(page, "/rules"))?.[1] ?? "";
  await setMoney(false);
  expect(await description()).not.toMatch(/money/i);
  await setMoney(true);
  expect(await description()).toMatch(/optional money between members/);
  await setMoney(false);
  expect(await description()).not.toMatch(/money/i);
});

test("the shortened Terms and Privacy keep consecutive numbering and every cross-reference lands on a real section", async ({ page }) => {
  await setMoney(false);
  await page.goto("/terms");
  const headings = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  expect(headings.map((h) => Number(h.split(".")[0]))).toEqual(headings.map((_, i) => i + 1));
  const termination = headings.findIndex((h) => /Termination$/.test(h)) + 1;
  await expect(page.getByText(`(see Section ${termination})`)).toBeVisible();
  const body = await page.locator("body").innerText();
  for (const m of body.matchAll(/Section (\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(headings.length);

  await page.goto("/privacy");
  const pHeadings = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  expect(pHeadings.map((h) => Number(h.split(".")[0]))).toEqual(pHeadings.map((_, i) => i + 1));
  expect(pHeadings.join("|")).not.toMatch(/Financial records/);
});

test("Sponsor commercial legal surfaces are unaffected by the Member capability", async ({ page }) => {
  for (const enabled of [false, true]) {
    await setMoney(enabled);
    const terms = await html(page, "/sponsor/terms");
    expect(terms).toContain("one or more methods, including online through a third-party payment service provider");
    const privacy = await html(page, "/privacy");
    expect(privacy).toContain("Sponsor accounts and sponsorships");
    expect(privacy).toContain("third-party payment service provider");
  }
});
