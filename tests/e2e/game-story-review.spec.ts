/**
 * THE GAME STORY REVIEW DESK, in a real browser: a candidate waits for an Admin (it is on no Post), the Admin sees the score by dimension, the atomic claims with the evidence behind each, and what was excluded; approving it puts
 * the story on the Game's one canonical Post (and nothing else about the Post or the Pick buttons changes); a rejected candidate shows why and changes nothing; an edited story cannot be approved until its facts are re-verified;
 * a Member cannot reach the desk. Candidates are written through the same database functions the engine uses (no model, no network). Local test accounts and a local database only.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const tag = randomUUID().slice(0, 6);

async function createUser(label: string, role: "player" | "admin") {
  const email = `e2e-gs-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: pe } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: `${label}${tag}`, username: `gs${label}${tag}`.toLowerCase(), role, is_active: true });
  if (pe) throw pe;
  await admin.rpc("confidence_bootstrap_member", { p_member_id: data.user.id });
  return { id: data.user.id as string, email };
}
async function loginAs(page: Page, email: string, expected: RegExp = /\/feed$/) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(expected);
}

async function seedGame(name: string) {
  const home = `GShome ${name} ${tag}`;
  const away = `GSaway ${name} ${tag}`;
  const { data: fixture, error } = await admin
    .from("fixtures")
    .insert({ provider: "api_nba", external_fixture_id: `e2e-gs-${randomUUID()}`, sport: "basketball", home_team_name: home, away_team_name: away, competition_name: "NBA", competition_external_id: "12", scheduled_start_utc: new Date(Date.now() + 20 * 3_600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  if (error || !fixture) throw error ?? new Error("failed to create fixture");
  const { error: me } = await admin.from("markets").insert({ provider: "api_nba", provider_market_id: `gs_ml_${randomUUID()}`, ingestion_source: "e2e", status: "ACTIVE", fixture_id: fixture.id, yes_price: 0.6, no_price: 0.4, liquidity: 1000, closes_at: new Date(Date.now() + 86_400_000).toISOString(), last_synced_at: new Date().toISOString(), question: "ml?", market_template: "MONEYLINE", yes_side: "HOME", line_value: null });
  if (me) throw me;
  const { data: post, error: pe } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (pe || !post) throw pe ?? new Error("failed to create post");
  return { home, away, fixtureId: fixture.id as string, postId: post.id as string };
}

/** A candidate written through the engine's own save function: 2 evidence items, 2 supported claims, 27+23+17+13+9 = 89. */
async function candidate(fixtureId: string, hook: string, body: string, decision: "ACCEPTED" | "REJECTED" = "ACCEPTED") {
  const { data: started } = await admin.rpc("start_game_story_run", { p_fixture_id: fixtureId, p_trigger: "SCHEDULED", p_admin_id: null });
  const runId = (started as Array<{ run_id: string; outcome: string }>)[0].run_id;
  if (!runId) throw new Error(`run not started: ${JSON.stringify(started)}`);
  const evidence = (text: string, over: Record<string, unknown> = {}) => ({ id: randomUUID(), position: 0, source_kind: "STRUCTURED_DATA", authority: 95, canonical_id: `brohda:fixtures:${randomUUID()}`, url: null, publisher: "Brohda game data", title: "Head-to-head results", published_at: null, retrieved_at: new Date().toISOString(), evidence_type: "STRUCTURED", fact_key: null, fact_value: null, subject_team: "BOTH", fact_text: text, excerpt: null, as_of: null, status: "USABLE", status_reason: null, ...over });
  const e1 = evidence("The home team has won the last 3 meetings.");
  const e2 = evidence("The home team has won 5 straight games.", { title: "Recent results" });
  const dropped = evidence("Boston is a 7-point favorite.", { source_kind: "OTHER_REPORTING", authority: 0, url: "https://www.draftkings.com/odds", publisher: "draftkings.com", evidence_type: "ARTICLE", status: "DROPPED", status_reason: "not_a_factual_source", canonical_id: "draftkings.com/odds" });
  const claim = (text: string, ids: string[], verdict = "SUPPORTED") => ({ id: randomUUID(), position: 0, text, type: "HISTORY", subject_team: "BOTH", availability_status: null, quote_text: null, verdict, deterministic_ok: verdict === "SUPPORTED", model_verdict: "SUPPORTED", note: "ok", evidence_ids: ids });
  const rejected = decision === "REJECTED";
  const payload = {
    decision, rejection_code: rejected ? "UNSUPPORTED_CLAIM" : null, rejection_detail: rejected ? "The claim states 9, which the cited evidence does not contain." : null, candidate_hook: hook, candidate_body: body,
    dims: rejected ? null : { relevance: 27, evidence: 23, debate: 17, originality: 13, freshness: 9 }, counters: { queries: 0, model_calls: 4, search_calls: 0, input_tokens: 1200, output_tokens: 400 }, elapsed_ms: 2500, prompt_version: "e2e", research_version: "e2e",
    details: { angles: [{ type: "STREAK_VS_STREAK", summary: "A streak meets a slump", evidence: 2, usable: true }], candidates: [] }, evidence: [e1, e2, dropped],
    claims: [claim("The home team has won the last 3 meetings", [e1.id]), claim(rejected ? "The home team has won 9 straight games" : "The home team has won 5 straight games", [e2.id], rejected ? "UNSUPPORTED" : "SUPPORTED")],
    revision: rejected ? null : { hook, body },
  };
  const { error } = await admin.rpc("save_game_story_run_result", { p_run_id: runId, p_payload: payload });
  if (error) throw error;
  return runId;
}

test.beforeAll(async () => {
  await admin.from("game_story_config").update({ generation_enabled: true }).eq("id", true);
});
test.afterAll(async () => {
  await admin.from("game_story_config").update({ generation_enabled: false }).eq("id", true);
});

test("an Admin reviews a candidate with its evidence, approves it onto the canonical Post, and Members see the story; a rejected candidate changes nothing", async ({ page }) => {
  test.setTimeout(240_000);
  const staff = await createUser("staff", "admin");
  const member = await createUser("member", "player");
  const g = await seedGame("approve");
  const hook = `Five straight. Who stops it ${tag}?`;
  const body = "The home side has won five straight and the last three meetings. Does the streak survive?";
  const runId = await candidate(g.fixtureId, hook, body);

  // generation is not publication: a Member sees no story yet
  await loginAs(page, member.email);
  await page.goto(`/post/${g.postId}`);
  await expect(page.locator('[data-slot="game-story"]')).toHaveCount(0);

  await loginAs(page, staff.email);
  await page.goto("/admin/game-stories");
  const item = page.locator('[data-slot="review-item"]').filter({ hasText: hook });
  await expect(item).toBeVisible();
  await expect(item).toContainText("score 89/100");
  await item.getByRole("link", { name: /evidence, claims and scores/i }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/game-stories/${runId}`));
  await expect(page.locator('[data-slot="score"]')).toContainText("Score 89/100");
  await expect(page.locator('[data-slot="score"]')).toContainText("Relevance to the matchup: 27/30");
  await expect(page.locator('[data-slot="claims"]')).toContainText("The home team has won the last 3 meetings");
  await expect(page.locator('[data-slot="claims"]')).toContainText("supported by Brohda game data");
  await expect(page.locator('[data-slot="evidence"]')).toContainText("not_a_factual_source"); // what was excluded, and why
  await expect(page.locator('[data-slot="angles"]')).toContainText("STREAK_VS_STREAK");

  await page.getByRole("button", { name: /approve and put on the post/i }).click();
  // the desk re-renders into its new state: the run now shows the story as live on the Post
  await expect(page.locator('[data-slot="run-live"]')).toContainText("This story is live on the Post");
  const { data: post } = await admin.from("posts").select("story_revision_id").eq("id", g.postId).single();
  expect(post!.story_revision_id).not.toBeNull();

  await loginAs(page, member.email);
  await page.goto(`/post/${g.postId}`);
  await expect(page.locator('[data-slot="game-story-hook"]')).toHaveText(hook);
  await expect(page.locator('[data-slot="game-story-body"]')).toHaveText(body);
  await expect(page.locator('[data-slot="game-story"]')).not.toContainText(/source|according to|#/i);
  // one canonical Post, and the prediction experience is unchanged
  expect((await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", g.fixtureId)).count).toBe(1);
  await page.goto("/feed");
  await expect(page.locator("article").filter({ hasText: g.home }).getByRole("button", { name: new RegExp(`Pick ${g.home}`) })).toBeVisible();
});

test("a rejected candidate shows why and puts nothing on the Post", async ({ page }) => {
  test.setTimeout(180_000);
  const staff = await createUser("staff2", "admin");
  const g = await seedGame("reject");
  const runId = await candidate(g.fixtureId, `Nine straight? ${tag}`, "The home side has won nine straight games and hosts a team that cannot stop it. Does anyone?", "REJECTED");
  await loginAs(page, staff.email);
  await page.goto(`/admin/game-stories/${runId}`);
  await expect(page.locator('[data-slot="rejection"]')).toContainText("UNSUPPORTED_CLAIM");
  await expect(page.locator('[data-slot="rejection"]')).toContainText("does not contain");
  await expect(page.locator('[data-slot="claims"]')).toContainText("UNSUPPORTED");
  await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
  const { data: post } = await admin.from("posts").select("story_revision_id").eq("id", g.postId).single();
  expect(post!.story_revision_id).toBeNull();
});

test("an edited story cannot be approved until its facts are re-verified; the live copy is unchanged meanwhile", async ({ page }) => {
  test.setTimeout(180_000);
  const staff = await createUser("staff3", "admin");
  const g = await seedGame("edit");
  const hook = `Five straight again ${tag}`;
  await candidate(g.fixtureId, hook, "The home side has won five straight and the last three meetings. Does the streak survive?");
  await loginAs(page, staff.email);
  await page.goto("/admin/game-stories");
  const item = page.locator('[data-slot="review-item"]').filter({ hasText: hook });
  await item.getByText("Edit the words").click();
  await item.locator('textarea[name="body"]').fill("The home side has won six straight and the last three meetings. Does the streak survive?");
  await item.getByRole("button", { name: /save edit as a new revision/i }).click();
  // the original revision is superseded by the edit, so the desk re-renders with the new revision waiting
  const edited = page.locator('[data-slot="review-item"]').filter({ hasText: "six straight" });
  await expect(edited).toContainText("needs re-verification");
  await expect(edited.getByRole("button", { name: /approve and put on the post/i })).toBeDisabled();
  expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBeNull();
});

test("a Member cannot reach the review desk", async ({ page }) => {
  const member = await createUser("plain", "player");
  await loginAs(page, member.email);
  await page.goto("/admin/game-stories");
  await expect(page).toHaveURL(/\/feed/);
});
