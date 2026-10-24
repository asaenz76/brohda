/**
 * Brohda 2.1, Milestone 1 in a real browser: a team Pick on its own, Confidence optional, the team and the amount locked the moment Confidence is added, a Pick locked by an accepted Call BS that can still receive
 * Confidence, a Pick change that cancels a pending Call BS, the deadline (T-10) closing every control, and the Super Admin switches. With the switches OFF the one-step composer is unchanged.
 * Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
test.describe.configure({ mode: "serial" });
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tag = randomUUID().slice(0, 6);

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const email = `e2e-oc-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `o${label}${tag}`.toLowerCase(), role, is_active: true });
  if (profileError) throw profileError;
  await admin.rpc("confidence_bootstrap_member", { p_member_id: data.user.id });
  return { id: data.user.id as string, email };
}
async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}
async function seedGame(name: string, startsInMinutes = 180) {
  const home = `Ohome ${name} ${tag}`;
  const away = `Oaway ${name} ${tag}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `e2e-oc-${randomUUID()}`, home_team_name: home, away_team_name: away, scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: `e2e_oc_${randomUUID()}`, provider_market_id: `m_${randomUUID()}`, question: "E2E prediction", status: "ACTIVE", fixture_id: fixture.id, market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.62, no_price: 0.38,
      price_outcome_labels: { yes: `${home} wins`, no: `${home} does not win` }, liquidity: 1000, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), ingestion_source: "e2e_test",
    })
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { home, away, fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
}
async function dbPick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { data, error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
  return (data as Row).prediction as Row;
}
const card = (page: Page, g: { home: string; away: string }) => page.locator("article", { hasText: g.home }).filter({ hasText: g.away });
const levelBtn = (scope: ReturnType<Page["locator"]>, n: number) => scope.locator(`[data-slot="confidence-choice"][data-amount="${n}"]`);
const pickOf = async (userId: string, marketId: string) => ((await admin.from("predictions").select("*").eq("user_id", userId).eq("market_id", marketId).maybeSingle()).data ?? null) as Row | null;
const stakeOf = async (predictionId: string) => ((await admin.from("confidence_prediction_stakes").select("*").eq("prediction_id", predictionId).maybeSingle()).data ?? null) as Row | null;
async function gotoFeedReady(page: Page) {
  await page.goto("/feed");
  await page.waitForLoadState("networkidle");
}

async function sqlReplica(text: string) {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query(text);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const resetPolicy = () => sqlReplica("update public.platform_settings set confidence_mandatory_since = null, confidence_optional_picks_enabled = false, confidence_optional_first_enabled_at = null, confidence_two_step_composer_enabled = false where id = true");
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};

let saved: Row | null = null;
let alice: { id: string; email: string };
let bob: { id: string; email: string };
let owner: { id: string; email: string };
test.beforeAll(async () => {
  saved = ((await admin.from("platform_settings").select("confidence_enabled, confidence_backed_picks_enabled, confidence_allowed_stakes, confidence_baseline, pick_lock_minutes_before_kickoff, call_bs_enabled").eq("id", true).single()).data) as Row;
  await resetPolicy();
  await setSettings({ confidence_enabled: true, confidence_backed_picks_enabled: true, confidence_baseline: 50, confidence_allowed_stakes: [1, 2, 3, 4, 5], pick_lock_minutes_before_kickoff: 10, call_bs_enabled: true });
  alice = await createMember("alice");
  bob = await createMember("bob");
  owner = await createMember("owner", "super_admin");
  // production-shaped: the mandatory cutover is set; optional Picks and the two-step composer are switched on through the audited functions
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: owner.id, p_config: { confidence_mandatory: true } })).error).toBeNull();
});
test.afterAll(async () => {
  await resetPolicy();
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});
const optionalOn = async () => {
  expect((await admin.rpc("admin_set_confidence_optional_picks", { p_admin_id: owner.id, p_enabled: true })).error).toBeNull();
  expect((await admin.rpc("admin_set_confidence_two_step_composer", { p_admin_id: owner.id, p_enabled: true })).error).toBeNull();
};

test("with the switches OFF nothing changes: the one-step composer asks for Confidence with the side, and there is no optional step", async ({ page }) => {
  test.setTimeout(120_000);
  const g = await seedGame("off");
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c.getByText("How confident are you?").first()).toBeVisible();
  await expect(c.getByText("(optional)")).toHaveCount(0);
  await expect(levelBtn(c, 3)).toBeDisabled(); // a level waits for a side: the mandatory one-step composer
  expect(await pickOf(alice.id, g.marketId)).toBeNull();
});

test("the two-step card: a team is a pick on its own (no Confidence), the team can be switched until it locks, and Confidence is a second, optional step that locks the team AND the amount", async ({ page }) => {
  test.setTimeout(240_000);
  await optionalOn();
  const g = await seedGame("twostep");
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c.getByText("Make your pick", { exact: true })).toBeVisible();
  await expect(levelBtn(c, 1)).toHaveCount(0); // no Confidence until there is a pick

  // Step 1: choose a team — that alone is a pick
  await c.getByRole("button", { name: new RegExp(`Pick ${g.home}`) }).click();
  await expect(c.getByText("You can change your pick until it locks.")).toBeVisible();
  const first = (await pickOf(alice.id, g.marketId))!;
  expect(first.selected_outcome).toBe("YES");
  expect(first.locked_at).toBeNull();
  expect(await stakeOf(first.id)).toBeNull();

  // the team can be switched freely before it locks, and the change is a revision
  await c.getByRole("button", { name: new RegExp(`Pick ${g.away}`) }).click();
  await expect.poll(async () => (await pickOf(alice.id, g.marketId))?.selected_outcome).toBe("NO");
  expect(((await admin.from("prediction_revisions").select("id").eq("prediction_id", first.id)).data ?? []).length).toBe(1);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(c.getByRole("button", { name: new RegExp(`Pick ${g.away}`) })).toHaveAttribute("aria-pressed", "true");
  await expect(c.getByText(/predicted/)).toHaveCount(0); // not final yet: no crowd sentiment

  // Step 2: optional Confidence — one tap locks the team and the amount
  await expect(c.getByText("(optional)")).toBeVisible();
  await levelBtn(c, 3).click();
  await expect(c.getByText(/Confidence · Locked/)).toBeVisible();
  await expect(c.getByText("Your team and your Confidence are locked.")).toBeVisible();
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(0);
  const stake = (await stakeOf(first.id))!;
  expect([stake.amount, stake.selected_outcome, stake.state]).toEqual([3, "NO", "RESERVED"]);
  const locked = (await pickOf(alice.id, g.marketId))!;
  expect([locked.selected_outcome, locked.lock_reason]).toEqual(["NO", "CONFIDENCE_COMMITTED"]);

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(c.getByText(`You picked ${g.away}`)).toBeVisible();
  await expect(c.getByLabel("3 Confidence, locked")).toBeVisible();
  await expect(c.getByText(/predicted/)).toBeVisible(); // final: the crowd is revealed
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(0);
});

test("a pick without Confidence stays a pick: it persists, and at T-10 it becomes the final record — every control closes", async ({ page }) => {
  test.setTimeout(240_000);
  await optionalOn();
  const g = await seedGame("nodeadline", 60);
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await c.getByRole("button", { name: new RegExp(`Pick ${g.home}`) }).click();
  await expect(c.getByText("You can change your pick until it locks.")).toBeVisible();
  // T-10 arrives (kickoff is now 5 minutes away)
  await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", g.fixtureId);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(c.getByText(new RegExp(`You picked ${g.home} — Picks are locked for this game`))).toBeVisible();
  await expect(c.getByRole("button", { name: /^Pick / })).toHaveCount(0);
  await expect(levelBtn(c, 1)).toHaveCount(0);
  const final = (await pickOf(alice.id, g.marketId))!;
  expect(final.selected_outcome).toBe("YES");
});

test("a pick locked by an accepted Call BS keeps its team but can still receive Confidence before T-10 — and a team change by someone with a pending Call BS cancels it with a notice", async ({ page }) => {
  test.setTimeout(300_000);
  await optionalOn();
  // (1) accepted Call BS + Confidence
  const g = await seedGame("callbs");
  const aPick = await dbPick(alice.id, g.marketId, "YES");
  const bPick = await dbPick(bob.id, g.marketId, "NO");
  const made = await admin.rpc("call_bs", { p_challenger_user_id: bob.id, p_recipient_prediction_id: aPick.id });
  expect(made.error).toBeNull();
  const accepted = await admin.rpc("accept_call_bs", { p_challenge_id: (made.data as Row).id, p_recipient_user_id: alice.id }).single();
  expect(((accepted.data as Row).outcome)).toBe("accepted");
  await loginAs(page, alice.email);
  await gotoFeedReady(page);
  const c = card(page, g);
  await expect(c.getByText("Your team is locked by an accepted Call BS.")).toBeVisible();
  await expect(c.getByRole("button", { name: new RegExp(`Pick ${g.home}`) })).toBeDisabled();
  await levelBtn(c, 2).click();
  await expect(c.getByText(/Confidence · Locked/)).toBeVisible();
  expect((await stakeOf(aPick.id))!.amount).toBe(2);
  expect((await pickOf(alice.id, g.marketId))!.selected_outcome).toBe("YES"); // the team never moved
  expect(await stakeOf(bPick.id)).toBeNull(); // nothing was transferred or pooled
  expect(((await admin.from("challenges").select("status").eq("id", (made.data as Row).id).single()).data as Row).status).toBe("ACCEPTED");

  // (2) a pending Call BS ends when its Pick changes; the other Member is told, the editor is not
  const g2 = await seedGame("cancel");
  const a2 = await dbPick(alice.id, g2.marketId, "YES");
  const b2 = await dbPick(bob.id, g2.marketId, "NO");
  const pending = await admin.rpc("call_bs", { p_challenger_user_id: bob.id, p_recipient_prediction_id: a2.id });
  expect(pending.error).toBeNull();
  const challengeId = (pending.data as Row).id as string;
  await gotoFeedReady(page);
  const c2 = card(page, g2);
  await c2.getByRole("button", { name: new RegExp(`Pick ${g2.away}`) }).click();
  await expect(c2.getByText("Your change cancelled a Call BS challenge.")).toBeVisible();
  const ended = (await admin.from("challenges").select("status, expiry_reason").eq("id", challengeId).single()).data as Row;
  expect([ended.status, ended.expiry_reason]).toEqual(["EXPIRED", "PICK_CHANGED"]);
  await expect.poll(async () => ((await admin.from("notifications").select("id").eq("user_id", bob.id).eq("challenge_id", challengeId).eq("type", "CALL_BS_CANCELLED")).data ?? []).length).toBe(1);
  expect(((await admin.from("notifications").select("id").eq("user_id", alice.id).eq("challenge_id", challengeId).eq("type", "CALL_BS_CANCELLED")).data ?? []).length).toBe(0);
  expect(b2.id).toBeTruthy();
});

test("the Super Admin switches for optional Picks and the two-step composer are audited and reversible, and the first-enabled instant is kept", async ({ page }) => {
  test.setTimeout(180_000);
  await resetPolicy();
  expect((await admin.rpc("admin_set_confidence_config", { p_admin_id: owner.id, p_config: { confidence_mandatory: true } })).error).toBeNull();
  await loginAs(page, owner.email);
  await page.goto("/admin/confidence");
  const card2 = page.locator('[data-slot="optional-picks"]');
  await expect(card2.locator('[data-slot="optional-picks-policy"]').getByText("Off")).toBeVisible();
  await card2.locator('[data-slot="optional-picks-policy"]').getByRole("button", { name: "Turn on" }).click();
  await expect(card2.locator('[data-slot="optional-picks-policy"]').getByText("On", { exact: true })).toBeVisible();
  const s1 = ((await admin.from("platform_settings").select("confidence_optional_picks_enabled, confidence_optional_first_enabled_at, confidence_mandatory_since").eq("id", true).single()).data) as Row;
  expect(s1.confidence_optional_picks_enabled).toBe(true);
  expect(s1.confidence_optional_first_enabled_at).not.toBeNull();
  await card2.locator('[data-slot="two-step-composer-flag"]').getByRole("button", { name: "Turn on" }).click();
  await expect.poll(async () => ((await admin.from("platform_settings").select("confidence_two_step_composer_enabled").eq("id", true).single()).data as Row).confidence_two_step_composer_enabled).toBe(true);
  await card2.locator('[data-slot="optional-picks-policy"]').getByRole("button", { name: "Turn off" }).click();
  await expect.poll(async () => ((await admin.from("platform_settings").select("confidence_optional_picks_enabled").eq("id", true).single()).data as Row).confidence_optional_picks_enabled).toBe(false);
  const s2 = ((await admin.from("platform_settings").select("confidence_optional_first_enabled_at, confidence_mandatory_since").eq("id", true).single()).data) as Row;
  expect(s2.confidence_optional_first_enabled_at).toBe(s1.confidence_optional_first_enabled_at); // kept when switched off
  expect(s2.confidence_mandatory_since).toBe(s1.confidence_mandatory_since); // the one-way cutover never moved
  const audits = ((await admin.from("audit_logs").select("action").eq("actor_id", owner.id).in("action", ["settings.confidence_optional_picks_updated", "settings.confidence_two_step_composer_updated"])).data ?? []) as Row[];
  expect(audits.length).toBeGreaterThanOrEqual(3);
  await expect(page.locator('[data-slot="prediction-capacity"]')).toContainText("Era: Confidence optional");
});
