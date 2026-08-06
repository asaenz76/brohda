/**
 * spec §22 E2E: "invitation → registration → login". Requires the local
 * Supabase stack (`pnpm supabase:start`) and app (`pnpm dev`, or let
 * Playwright's webServer start it) to be running with SUPABASE_SERVICE_ROLE_KEY
 * set in the environment.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

test("invitation → registration → login", async ({ page }) => {
  test.skip(!SERVICE_ROLE_KEY, "Requires a local Supabase instance (SUPABASE_SERVICE_ROLE_KEY)");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const suffix = Date.now();
  const adminEmail = `e2e-admin-${suffix}@example.com`;
  const { data: adminUser, error: adminCreateError } = await admin.auth.admin.createUser({
    email: adminEmail,
    password: "admin-password-123",
    email_confirm: true,
  });
  expect(adminCreateError).toBeNull();

  await admin.from("user_profiles").insert({
    id: adminUser!.user!.id,
    display_name: "E2E Admin",
    role: "super_admin",
    is_active: true,
  });

  const inviteeEmail = `e2e-invitee-${suffix}@example.com`;
  const { data: invitation, error: inviteError } = await admin
    .from("invitations")
    .insert({ email: inviteeEmail, invited_by: adminUser!.user!.id })
    .select("token")
    .single();
  expect(inviteError).toBeNull();

  await page.goto(`/invite/${invitation!.token}`);
  await page.getByLabel("Display name").fill("E2E Invitee");
  // exact: true — the default substring match also catches the
  // PasswordInput toggle button's aria-label="Show password".
  await page.getByLabel("Password", { exact: true }).fill("invitee-password-123");
  await page.getByRole("checkbox", { name: /accept the community rules/i }).check();
  await page.getByRole("button", { name: /join brohda/i }).click();

  await expect(page).toHaveURL(/\/feed$/);

  await page.goto("/profile");
  await page.getByRole("button", { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Email").fill(inviteeEmail);
  await page.getByLabel("Password", { exact: true }).fill("invitee-password-123");
  await page.getByRole("button", { name: /log in/i }).click();

  await expect(page).toHaveURL(/\/feed$/);
});
