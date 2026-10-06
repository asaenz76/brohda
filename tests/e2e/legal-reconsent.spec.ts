/**
 * E2E: the deliberate re-consent switch. `platform_settings.legal_reconsent_required` is empty by default and copy edits never touch it; when an
 * owner lists a document there, every signed-in member who hasn't accepted its CURRENT version is routed through /accept-terms (and returned to
 * where they were going) until they agree. It mutates the platform_settings singleton, so it runs in the serial settings project.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { LEGAL_DOCUMENTS } from "../../lib/legal/documents";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const suffix = randomUUID().slice(0, 8);
const users: string[] = [];

async function createMember(prefix: string) {
  const email = `rc-${prefix}-${suffix}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: `RC ${prefix}`, username: `rc${prefix}${suffix}`, role: "player", is_active: true });
  users.push(data.user.id);
  return { id: data.user.id as string, email };
}

async function logIn(page: Page, email: string, from = "/login") {
  await page.context().clearCookies();
  await page.goto(from);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
}

async function setRequired(documents: string[]) {
  const { error } = await admin.from("platform_settings").update({ legal_reconsent_required: documents }).eq("id", true);
  expect(error).toBeNull();
}

test.describe.configure({ mode: "serial" });

test.afterEach(async () => {
  await setRequired([]);
});

test.afterAll(async () => {
  await admin.from("platform_settings").update({ legal_reconsent_required: [] }).eq("id", true);
  for (const id of users) await admin.auth.admin.deleteUser(id);
});

test("the default is off: nobody is asked for anything", async ({ page }) => {
  const { data } = await admin.from("platform_settings").select("legal_reconsent_required").eq("id", true).single();
  expect(data?.legal_reconsent_required).toEqual([]);
  const m = await createMember("off");
  await logIn(page, m.email);
  await expect(page).toHaveURL(/\/feed$/);
});

test("when switched on, a member without the current version is held at /accept-terms, then sent on to where they were going", async ({ page }) => {
  const m = await createMember("on");
  await setRequired(["terms"]);
  await logIn(page, m.email, `/login?next=${encodeURIComponent("/profile")}`);
  await expect(page).toHaveURL(/\/accept-terms/);
  await expect(page.getByRole("heading", { name: /updated our Terms of Service/ })).toBeVisible();
  // Held: other member pages bounce back here until they agree.
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/accept-terms/);

  // The checkbox is required — submitting without it doesn't pass.
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/accept-terms/);

  await page.getByRole("checkbox", { name: /i have read and agree/i }).check();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/(feed|profile|notifications)$/);

  const { data: rows } = await admin.from("legal_acceptances").select("document, version, source").eq("user_id", m.id);
  expect(rows).toEqual([{ document: "terms", version: LEGAL_DOCUMENTS.terms.version, source: "reconsent" }]);

  // Accepted: not asked again.
  await page.goto("/feed");
  await expect(page).toHaveURL(/\/feed$/);
});

test("a member who already accepted the current version is not asked", async ({ page }) => {
  const m = await createMember("done");
  await admin.from("legal_acceptances").insert({ user_id: m.id, document: "terms", version: LEGAL_DOCUMENTS.terms.version, source: "register" });
  await setRequired(["terms"]);
  await logIn(page, m.email);
  await expect(page).toHaveURL(/\/feed$/);
});

test("both documents can be required together, and one agreement records both", async ({ page }) => {
  const m = await createMember("both");
  await setRequired(["terms", "privacy"]);
  await logIn(page, m.email);
  await expect(page).toHaveURL(/\/accept-terms/);
  await expect(page.getByRole("heading", { name: /Terms of Service and Privacy Policy/ })).toBeVisible();
  await page.getByRole("checkbox", { name: /i have read and agree/i }).check();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/feed$/);
  const { data: rows } = await admin.from("legal_acceptances").select("document").eq("user_id", m.id).order("document");
  expect(rows?.map((r) => r.document)).toEqual(["privacy", "terms"]);
});

test("a hostile next on /accept-terms is ignored", async ({ page }) => {
  const m = await createMember("evil");
  await setRequired(["privacy"]);
  await logIn(page, m.email);
  await expect(page).toHaveURL(/\/accept-terms/);
  await page.goto(`/accept-terms?next=${encodeURIComponent("https://evil.example")}`);
  await page.getByRole("checkbox", { name: /i have read and agree/i }).check();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page).toHaveURL(/\/feed$/);
});

test("the public legal pages stay reachable while re-consent is required (no trap)", async ({ page }) => {
  const m = await createMember("pub");
  await setRequired(["terms", "privacy"]);
  await logIn(page, m.email);
  await expect(page).toHaveURL(/\/accept-terms/);
  await page.goto("/terms");
  await expect(page).toHaveURL(/\/terms$/);
  await page.goto("/privacy");
  await expect(page).toHaveURL(/\/privacy$/);
});
