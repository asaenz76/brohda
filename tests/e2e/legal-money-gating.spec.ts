/**
 * Rules, Terms and Privacy in a real browser, with optional money ON and OFF. Money OFF here always has a wallet ledger entry on file (the spec
 * creates one), so the OFF state is the "retained" one: current-feature money copy is gone, the disclosure of the financial records we hold
 * stays. (The "no financial data ever stored" state needs a database with an empty ledger and is covered by tests/unit/legal-money-gating.test.tsx.)
 * It flips the platform_settings singleton, so it runs in its own serial project.
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

test("money OFF (records on file): no current-feature money copy anywhere, no placeholder — and the financial-records disclosure stays", async ({ page }) => {
  await setMoney(false);
  await page.goto("/rules");
  await expect(page.getByRole("heading", { name: "Money", exact: true })).toHaveCount(0);
  const rules = await page.getByRole("main").innerText().catch(async () => page.locator("body").innerText());
  expect(rules).not.toMatch(/offer money|money Position|wallet/i);

  await page.goto("/terms");
  const terms = await page.locator("body").innerText();
  await expect(page.getByRole("heading", { name: /Service fee/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Deposits and withdrawals happen outside the App/ })).toHaveCount(0);
  expect(terms).not.toMatch(/may add funds|commits part of their wallet balance|platform fee|optional money Position/i);
  await expect(page.getByRole("heading", { name: "3. Wallet records and withdrawals" })).toBeVisible();
  expect(terms).toContain("Where a member still has a balance, a withdrawal is paid by an administrator");

  await page.goto("/privacy");
  const privacy = await page.locator("body").innerText();
  expect(privacy).not.toContain("Money is private to the people involved");
  expect(privacy).toContain("Wallet and money records");
  expect(privacy).toContain("kept as permanent records of the Service's ledger");

  for (const out of [rules, terms, privacy]) expect(out).not.toMatch(/coming soon|money[^.]{0,80}(unavailable|switched off|disabled|paused)/i);
});

test("the cross-references in the shortened Terms still land on real sections", async ({ page }) => {
  await setMoney(false);
  await page.goto("/terms");
  const headings = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  expect(headings.map((h) => Number(h.split(".")[0]))).toEqual(headings.map((_, i) => i + 1));
  const termination = headings.findIndex((h) => /Termination$/.test(h)) + 1;
  await expect(page.getByText(`(see Section ${termination})`)).toBeVisible();
});
