/**
 * Member Messaging in a real browser: OFF by default (nothing visible, /messages is a 404, a Sponsor cannot reach it), Super Admin switches it on from Settings, and two Members go through a
 * message request, accept, reply, delete (tombstone), share a Game, mute, report, block and moderation — with a phone-width check. Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

test.describe.configure({ mode: "serial" });

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function createMember(label: string, role: "player" | "super_admin" = "player") {
  const tag = randomUUID().slice(0, 6);
  const email = `e2e-msg-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const displayName = `${label}${tag}`;
  const username = `m${label}${tag}`.toLowerCase();
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username, role, is_active: true });
  if (profileError) throw profileError;
  return { id: data.user.id as string, email, displayName, username };
}

async function createSponsorLogin() {
  const email = `e2e-msg-sponsor-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create sponsor login");
  const { data: org, error: accountError } = await admin.rpc("create_sponsor_account", { p_user_id: data.user.id, p_email: email, p_brand: `Msg Co ${randomUUID().slice(0, 4)}`, p_contact_name: "E2E", p_website: null, p_country: null, p_phone: null });
  if (accountError) throw accountError;
  await admin.from("sponsors").update({ status: "ACTIVE", logo_path: `${randomUUID()}/logo.webp` }).eq("id", (Array.isArray(org) ? org[0] : org).id);
  return { email };
}

async function loginAs(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function loginAsSponsor(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/sponsor/login");
  await page.getByLabel("Business email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/sponsor$/);
}

// E2E_SHOTS=<dir> saves screenshots for a visual check; normal runs skip it.
async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: false });
}

let saved: Row | null = null;
test.beforeAll(async () => {
  const { data } = await admin.from("platform_settings").select("messaging_enabled, messaging_poll_interval_seconds, messaging_unsend_window_seconds, messaging_max_message_length").eq("id", true).single();
  saved = data;
  await admin.from("platform_settings").update({ messaging_enabled: false, messaging_poll_interval_seconds: 3, messaging_unsend_window_seconds: 900, messaging_max_message_length: 1000 }).eq("id", true);
});
test.afterAll(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

test("off by default; Super Admin turns it on; two Members request, accept, reply, delete, share, mute, report and block; moderation hides a message", async ({ page }) => {
  test.setTimeout(300_000);
  const superAdmin = await createMember("admin", "super_admin");
  const a = await createMember("alice");
  const b = await createMember("bobby");
  const sponsor = await createSponsorLogin();

  // A published Game Post to share.
  const suffix = randomUUID().slice(0, 6);
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `e2e-msg-${randomUUID()}`, sport: "american_football", home_team_name: `Msg Home ${suffix}`, away_team_name: `Msg Away ${suffix}`, competition_name: "NFL", competition_external_id: "1", scheduled_start_utc: new Date(Date.now() + 24 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();

  // 1. OFF by default: no entry, no profile button, /messages is a plain 404.
  await loginAs(page, a.email);
  await expect(page.getByRole("link", { name: "Messages" })).toHaveCount(0);
  expect((await page.goto("/messages"))?.status()).toBe(404);
  await page.goto(`/profile/${b.username}`);
  await expect(page.locator('[data-slot="message-member"]')).toHaveCount(0);
  const offResponse = await page.request.get(`/api/messages/${randomUUID()}?after=0&since=${encodeURIComponent(new Date(0).toISOString())}`);
  expect(offResponse.status()).toBe(404);

  // 2. Super Admin turns it on from Settings.
  await loginAs(page, superAdmin.email);
  await page.goto("/admin/settings/brohda");
  const card = page.locator('[data-slot="messaging-settings"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-slot="messaging-state"]')).toHaveText("Off");
  await card.getByLabel("Members can send messages").check();
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByRole("status")).toContainText("Messaging is on.");
  await expect(card.locator('[data-slot="messaging-state"]')).toHaveText("On");
  await shot(page, "settings-messaging");

  // A Sponsor login can never reach Messaging: not the page, not the API.
  await loginAsSponsor(page, sponsor.email);
  await page.goto("/messages");
  await expect(page).not.toHaveURL(/\/messages/);
  const sponsorApi = await page.request.get(`/api/messages/${randomUUID()}?after=0&since=${encodeURIComponent(new Date(0).toISOString())}`);
  expect([401, 404]).toContain(sponsorApi.status()); // a Sponsor has no Member session: refused, and no data in the body
  expect(await sponsorApi.text()).toBe("");

  // 3. A messages B: profile → Message → a request.
  await loginAs(page, a.email);
  await expect(page.getByRole("link", { name: "Messages" }).first()).toBeVisible();
  await page.goto(`/profile/${b.username}`);
  await page.locator('[data-slot="message-member"]').click();
  await expect(page).toHaveURL(new RegExp(`/messages/with/${b.id}`));
  await expect(page.locator('[data-slot="request-explainer"]')).toContainText("message request");
  await page.getByLabel("Message", { exact: true }).fill("Hey, I think you're wrong about Sunday's game.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  const conversationUrl = page.url();
  await expect(page.locator('[data-slot="request-sent"]')).toBeVisible();
  await expect(page.locator('[data-slot="message"]').first()).toContainText("wrong about Sunday");

  // 4. B sees the request, cannot reply until accepting, then accepts.
  await loginAs(page, b.email);
  await page.goto("/messages?tab=requests");
  const requestRow = page.locator('[data-slot="inbox-row"][data-kind="request"]');
  await expect(requestRow).toContainText(a.displayName);
  await expect(requestRow).toContainText("Wants to message you");
  await shot(page, "inbox-requests");
  await requestRow.click();
  await expect(page.locator('[data-slot="request-banner"]')).toBeVisible();
  await expect(page.locator('[data-slot="composer"]')).toHaveCount(0); // no reply until accepted
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.locator('[data-slot="request-banner"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="composer"]')).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Bring the stats, then.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-slot="message"][data-from="me"]').last()).toContainText("Bring the stats");

  // 5. A shares a Game and writes a second message; then deletes the FIRST (request) message → a tombstone for both.
  await loginAs(page, a.email);
  await page.goto(conversationUrl);
  await expect(page.locator('[data-slot="request-sent"]')).toHaveCount(0); // accepted now
  await expect(page.locator('[data-slot="message"][data-from="them"]').last()).toContainText("Bring the stats", { timeout: 15_000 });
  await page.getByRole("button", { name: "Share a Game, Market, Pick or Call BS" }).click();
  await page.getByLabel("A Brohda Game or Market link").fill(`/post/${post!.id}`);
  await page.locator('[data-slot="share-panel"]').getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.locator('[data-slot="shared-object"][data-type="POST"]')).toContainText(`Msg Home ${suffix}`);
  await page.getByLabel("Message", { exact: true }).fill("Here is the game I mean.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-slot="message"][data-from="me"]').last()).toContainText("Here is the game I mean");
  await page.locator('[data-slot="message"][data-from="me"]').first().getByRole("button", { name: "Unsend" }).click();
  await expect(page.locator('[data-slot="tombstone"]').first()).toContainText("You deleted a message.");
  await shot(page, "conversation-desktop");

  // 6. B sees the tombstone and the shared card, mutes, reports a message, then blocks A.
  await loginAs(page, b.email);
  await page.goto(conversationUrl);
  await expect(page.locator('[data-slot="tombstone"]').first()).toContainText(`${a.displayName} deleted a message.`);
  await expect(page.locator('[data-slot="shared-object"][data-type="POST"]')).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("Hey, I think you're wrong"); // the original text is gone from the page
  await page.getByRole("button", { name: "Mute" }).click();
  await expect(page.locator('[data-slot="conversation-notice"]')).toContainText("Muted");
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();

  await page.locator('[data-slot="message"][data-from="them"]').filter({ hasText: "Here is the game I mean" }).getByRole("button", { name: "Report this message" }).click();
  const reportPanel = page.locator('[data-slot="report-panel"]');
  await expect(reportPanel).toContainText("Report this message");
  await reportPanel.getByLabel("Reason").selectOption("HARASSMENT");
  await reportPanel.getByRole("button", { name: "Send report" }).click();
  await expect(page.locator('[data-slot="conversation-notice"]')).toContainText("Brohda will review this");
  const { data: reports } = await admin.from("message_reports").select("id, reason, status, evidence, message_id").eq("reporter_id", b.id);
  expect(reports).toHaveLength(1);
  expect(reports![0]).toMatchObject({ reason: "HARASSMENT", status: "OPEN" });
  expect(JSON.stringify(reports![0].evidence)).toContain("Here is the game I mean");

  await page.getByRole("button", { name: "Block" }).click();
  await expect(page.locator('[data-slot="block-confirm"]')).toBeVisible();
  await page.locator('[data-slot="block-confirm"]').getByRole("button", { name: "Block" }).click();
  await expect(page.locator('[data-slot="conversation-notice"]')).toContainText("Blocked");
  await expect(page.locator('[data-slot="composer"]')).toHaveCount(0);

  // 7. A is now blocked: sending is refused with a neutral message that does not say why.
  await loginAs(page, a.email);
  await page.goto(conversationUrl);
  await page.getByLabel("Message", { exact: true }).fill("Why can't I reach you?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.locator('[data-slot="composer-status"]')).toHaveText("You can't message this Member.");
  expect(await page.locator("body").innerText()).not.toMatch(/blocked you|you have been blocked/i);

  // 8. Super Admin moderates: sees the bounded evidence, hides the message; B then sees it removed.
  await loginAs(page, superAdmin.email);
  await page.goto("/admin/moderation");
  const report = page.locator('[data-slot="report"][data-status="OPEN"]').filter({ hasText: b.displayName });
  await expect(report).toBeVisible();
  await report.getByText(/^Evidence \(/).click();
  await expect(report).toContainText("Here is the game I mean");
  await report.getByRole("button", { name: "Hide message" }).click();
  // The outcome, not the transient confirmation: resolving moves the report out of "Open" (so the card this locator points at is re-rendered away) and into "Recently resolved" as actioned.
  const resolved = page.locator('[data-slot="report"][data-status="ACTIONED"]').filter({ hasText: b.displayName });
  await expect(resolved).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="report"][data-status="OPEN"]').filter({ hasText: b.displayName })).toHaveCount(0);
  await expect(resolved).toContainText("Actioned");
  await shot(page, "moderation");
  await loginAs(page, b.email);
  await page.goto(conversationUrl);
  await expect(page.locator('[data-slot="message"][data-removed="MODERATED"]')).toContainText("This message was removed.");
  const { count } = await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("actor_id", superAdmin.id).in("action", ["messaging.report_hide_message", "settings.messaging_updated"]);
  expect(count).toBeGreaterThanOrEqual(2);

  // 9. Phone width: the inbox and a conversation fit with no sideways scroll, and the controls are reachable.
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/messages", conversationUrl]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} must not scroll sideways at 375px`).toBeLessThanOrEqual(0);
  }
  await shot(page, "conversation-mobile");
  await page.goto("/messages");
  await shot(page, "inbox-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("Block from a profile is a relationship boundary: the blocker's view hides the blocked Member's comment, nobody else's changes, replies between the pair are refused, and moderation shows signals and holds", async ({ page }) => {
  test.setTimeout(240_000);
  await admin.from("platform_settings").update({ messaging_enabled: true }).eq("id", true);
  const superAdmin = await createMember("owner", "super_admin");
  const a = await createMember("blocker");
  const b = await createMember("blocked");
  const c = await createMember("bystander");

  const suffix = randomUUID().slice(0, 6);
  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ provider: "api_nfl", external_fixture_id: `e2e-block-${randomUUID()}`, sport: "american_football", home_team_name: `Blk Home ${suffix}`, away_team_name: `Blk Away ${suffix}`, competition_name: "NFL", competition_external_id: "1", scheduled_start_utc: new Date(Date.now() + 24 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixture!.id, published_at: new Date().toISOString() }).select("id").single();
  const aText = `from-blocker-${suffix}`;
  const bText = `from-blocked-${suffix}`;
  const cText = `bystander-reply-${suffix}`;
  const aComment = (await admin.rpc("add_post_comment", { p_post_id: post!.id, p_user_id: a.id, p_body: aText, p_parent_comment_id: null }).single()).data as Row;
  const bComment = (await admin.rpc("add_post_comment", { p_post_id: post!.id, p_user_id: b.id, p_body: bText, p_parent_comment_id: null }).single()).data as Row;
  await admin.rpc("add_post_comment", { p_post_id: post!.id, p_user_id: c.id, p_body: cText, p_parent_comment_id: bComment.id });
  expect(aComment.id).toBeTruthy();

  // A blocks B from B's profile. Block works without opening a conversation, and asks first.
  await loginAs(page, a.email);
  await page.goto(`/profile/${b.username}`);
  const block = page.locator('[data-slot="block-member"]');
  await block.getByRole("button", { name: "Block", exact: true }).click();
  await expect(block.getByRole("alertdialog")).toContainText("Everyone else still sees them");
  await block.getByRole("button", { name: "Block", exact: true }).click();
  await expect(block.getByRole("status")).toContainText("Blocked.");
  await expect(block.getByRole("button", { name: "Unblock" })).toBeVisible();
  await shot(page, "profile-blocked");

  // A's view: B's comment is a placeholder (kept only because C replied beneath it); C's reply and A's own comment are there; B's text is not.
  await page.goto(`/post/${post!.id}`);
  await expect(page.getByText(aText)).toBeVisible();
  await expect(page.locator('[data-slot="comment-hidden-by-block"]')).toBeVisible();
  await expect(page.getByText(cText)).toBeVisible();
  await expect(page.getByText(bText)).toHaveCount(0);
  await shot(page, "post-blocked-view");

  // B (the blocked Member) sees everything exactly as before, and a direct reply to A is refused with one neutral sentence.
  await loginAs(page, b.email);
  await page.goto(`/post/${post!.id}`);
  await expect(page.getByText(aText)).toBeVisible();
  await expect(page.getByText(bText)).toBeVisible();
  await expect(page.locator('[data-slot="comment-hidden-by-block"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Reply" }).first().click(); // A's comment is first in the thread
  await page.getByPlaceholder(/^Reply to /).fill("hello blocker");
  await page.getByRole("button", { name: "Post", exact: true }).first().click();
  await expect(page.getByText("You can't reply to this comment.")).toBeVisible();
  expect((await admin.from("post_comments").select("id").eq("body", "hello blocker")).data).toEqual([]);

  // Everyone else (C) sees both comments normally: a block is not moderation.
  await loginAs(page, c.email);
  await page.goto(`/post/${post!.id}`);
  await expect(page.getByText(aText)).toBeVisible();
  await expect(page.getByText(bText)).toBeVisible();

  // Moderation: an abuse signal and a retention hold are visible to the Super Admin and can be dismissed / released, each with a note and an audit entry.
  const { data: signal } = await admin.from("messaging_abuse_signals").insert({ member_id: b.id, signal_type: "DUPLICATE_BURST", observed_count: 6, threshold: 4, window_seconds: 86400 }).select("id").single();
  const { data: report } = await admin.from("message_reports").insert({ reporter_id: c.id, reported_member_id: b.id, scope: "CONVERSATION", reason: "SPAM", evidence: [] }).select("id").single();
  await loginAs(page, superAdmin.email);
  await page.goto("/admin/moderation");
  const signalCard = page.locator(`[data-slot="abuse-signal"][data-type="DUPLICATE_BURST"]`, { hasText: b.displayName });
  await expect(signalCard).toContainText("The same message sent repeatedly");
  await expect(signalCard).toContainText("flagged only");
  await signalCard.getByRole("button", { name: "Dismiss" }).click();
  // The outcome, not the transient confirmation: resolving re-renders the list without this signal, so the card (and its status line) goes away.
  await expect.poll(async () => (await admin.from("messaging_abuse_signals").select("status").eq("id", signal!.id).single()).data!.status).toBe("DISMISSED");
  await expect(signalCard).toHaveCount(0);

  const reportCard = page.locator('[data-slot="report"]', { hasText: b.displayName }).first();
  await reportCard.getByText("Place a retention hold").click();
  await reportCard.getByRole("button", { name: "Place hold" }).click();
  await expect(reportCard.getByRole("alert")).toContainText("Add a short note");
  await reportCard.getByLabel("Why (required)").fill("counsel asked us to keep this case");
  await reportCard.getByRole("button", { name: "Place hold" }).click();
  // Outcome-based: placing the hold re-renders the page with the hold listed, so the confirmation line may already be gone.
  await expect.poll(async () => (await admin.from("messaging_retention_holds").select("id").eq("report_id", report!.id).is("released_at", null)).data?.length).toBe(1);
  await page.reload();
  await expect(page.locator('[data-slot="holds"]')).toContainText("one report");
  await page.locator('[data-slot="hold"]').first().getByRole("button", { name: "Release hold" }).click();
  await expect.poll(async () => (await admin.from("messaging_retention_holds").select("released_at").eq("report_id", report!.id).single()).data!.released_at).not.toBeNull();
  await shot(page, "moderation-signals-holds");

  // A unblocks B: the placeholder goes away.
  await loginAs(page, a.email);
  await page.goto(`/profile/${b.username}`);
  await page.locator('[data-slot="block-member"]').getByRole("button", { name: "Unblock" }).click();
  await expect(page.locator('[data-slot="block-member"]').getByRole("status")).toContainText("Unblocked.");
  await page.goto(`/post/${post!.id}`);
  await expect(page.getByText(bText)).toBeVisible();
  await expect(page.locator('[data-slot="comment-hidden-by-block"]')).toHaveCount(0);
});
