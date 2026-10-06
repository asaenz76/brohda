/**
 * Prediction-card simplification, in a real browser. The canonical Market model is unchanged — a Pick is still stored, graded and
 * compared as "YES" | "NO" — but what people read and tap is the Game's own language: the two teams (Moneyline), team + signed line
 * (Spread), Over / Under (Total). For each template: see the labels, pick, reload, change before the cutoff, see the opposing
 * participant (and the Call BS / money actions on opposing *visible* choices), read sentiment against the visible sides, and read
 * the graded result — all against the canonical selection stored in the database.
 *
 * Each template gets its own American-football Game (so the matchup order is Away @ Home) with one Market and one published Post.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";

type Outcome = "YES" | "NO";
interface Choice {
  outcome: Outcome;
  label: string;
  name: string;
}
interface Template {
  key: "moneyline" | "spread" | "total";
  marketLabel: string;
  market: { market_template: string; yes_side: string | null; line_value: number | null };
  /** In DISPLAY order. */
  choices: (home: string, away: string) => [Choice, Choice];
  /** Final score that makes canonical YES true. */
  yesScore: { home: number; away: number };
}

const TEMPLATES: Template[] = [
  {
    key: "moneyline",
    marketLabel: "Moneyline",
    market: { market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
    choices: (home, away) => [
      { outcome: "NO", label: away, name: `Pick ${away} to win` },
      { outcome: "YES", label: home, name: `Pick ${home} to win` },
    ],
    yesScore: { home: 24, away: 10 },
  },
  {
    key: "spread",
    marketLabel: "Spread",
    market: { market_template: "SPREAD", yes_side: "HOME", line_value: 3.5 },
    choices: (home, away) => [
      { outcome: "NO", label: `${away} -3.5`, name: `Pick ${away} minus 3.5` },
      { outcome: "YES", label: `${home} +3.5`, name: `Pick ${home} plus 3.5` },
    ],
    yesScore: { home: 17, away: 20 }, // 17 + 3.5 > 20: the home side covers
  },
  {
    key: "total",
    marketLabel: "Total 47.5",
    market: { market_template: "TOTAL", yes_side: null, line_value: 47.5 },
    choices: () => [
      { outcome: "YES", label: "Over 47.5", name: "Pick Over 47.5 total points" },
      { outcome: "NO", label: "Under 47.5", name: "Pick Under 47.5 total points" },
    ],
    yesScore: { home: 30, away: 24 }, // 54 > 47.5
  },
];

async function createPlayer(label: string) {
  const email = `e2e-cardlabels-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: `${label}${Math.floor(Math.random() * 100000)}`,
    username: `cl${label}${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;
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

async function seedGame(template: Template, home: string, away: string, startsInMinutes = 24 * 60) {
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({
      external_fixture_id: `e2e-cardlabels-${randomUUID()}`,
      sport: "american_football",
      home_team_name: home,
      away_team_name: away,
      competition_name: "NFL",
      scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create fixture");

  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: "e2e_cardlabels",
      provider_market_id: `cl_${randomUUID()}`,
      question: `Old-style question text ${randomUUID()}?`,
      status: "ACTIVE",
      fixture_id: fixture.id,
      yes_price: 0.6,
      no_price: 0.4,
      liquidity: 1000,
      last_synced_at: new Date().toISOString(),
      ingestion_source: "e2e_test",
      provider_metadata: {},
      ...template.market,
    })
    .select("id, question")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");

  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { fixtureId: fixture.id as string, marketId: market.id as string, question: market.question as string, postId: post.id as string };
}

async function cleanup(game: { fixtureId: string; marketId: string }, userIds: string[]) {
  await admin.from("predictions").delete().eq("market_id", game.marketId);
  await admin.from("posts").delete().eq("fixture_id", game.fixtureId);
  await admin.from("markets").delete().eq("id", game.marketId);
  await admin.from("fixtures").delete().eq("id", game.fixtureId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
}

const article = (page: Page, home: string, away: string) => page.getByRole("article", { name: `Game: ${away} at ${home}` });

async function storedSelection(userId: string, marketId: string) {
  const { data } = await admin.from("predictions").select("selected_outcome").eq("user_id", userId).eq("market_id", marketId).single();
  return data?.selected_outcome as Outcome | undefined;
}

for (const template of TEMPLATES) {
  test.describe(`${template.marketLabel} card`, () => {
    test(`shows its labels, picks, survives reload, changes before the cutoff, shows the opposing participant and sentiment, and reads the graded result — against the canonical selection`, async ({ page }) => {
      const suffix = randomUUID().slice(0, 8);
      const home = `Hometeam ${suffix}`;
      const away = `Awayteam ${suffix}`;
      const [first, second] = template.choices(home, away);
      const yes = [first, second].find((c) => c.outcome === "YES")!;
      const no = [first, second].find((c) => c.outcome === "NO")!;
      const game = await seedGame(template, home, away);
      const one = await createPlayer("one");
      const two = await createPlayer("two");

      try {
        // --- See the labels (and nothing of the old Yes/No form).
        await loginAs(page, one.email);
        await page.goto("/feed");
        const card = article(page, home, away);
        await expect(card).toBeVisible();
        const picker = card.getByTestId("prediction-actions");
        await expect(picker.getByRole("button")).toHaveText([first.label, second.label]); // display order
        await expect(picker.getByRole("button", { name: first.name, exact: true })).toBeVisible();
        await expect(picker.getByRole("button", { name: second.name, exact: true })).toBeVisible();
        await expect(card).not.toContainText(/do not win|Will the|Old-style question/i);
        await expect(picker).not.toContainText(/\bYes\b|\bNo\b/);
        if (template.key === "moneyline") await expect(card.getByText("Moneyline")).toHaveCount(0); // the teams are the Market
        else await expect(card.getByText(template.marketLabel, { exact: true })).toBeVisible();

        // --- Pick one side: the canonical selection stored is the one that choice stands for.
        await card.getByRole("button", { name: yes.name, exact: true }).click();
        await expect(card.getByText("Change your prediction")).toBeVisible();
        await expect.poll(() => storedSelection(one.id, game.marketId)).toBe("YES");

        // --- Reload: the selected state is still on the same visible choice.
        await page.reload();
        await expect(card.getByRole("button", { name: yes.name, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(card.getByRole("button", { name: no.name, exact: true })).toHaveAttribute("aria-pressed", "false");

        // --- Change before the cutoff: the selection and the stored value move together.
        await card.getByRole("button", { name: no.name, exact: true }).click();
        await expect(card.getByRole("button", { name: no.name, exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => storedSelection(one.id, game.marketId)).toBe("NO");

        // --- An opposing participant: they pick the other visible side (stored YES).
        await loginAs(page, two.email);
        await page.goto("/feed");
        await card.getByRole("button", { name: yes.name, exact: true }).click();
        await expect.poll(() => storedSelection(two.id, game.marketId)).toBe("YES");
        await page.reload();
        // Sentiment sits against the visible sides, in the same order: the canonical 50/50 relabelled.
        await expect(card.getByText(`${first.label} 50% · ${second.label} 50% · 2 predicted`)).toBeVisible();

        // On the Post, the other person's Pick reads as their visible choice, and the actions sit on opposing visible choices.
        await page.goto(`/post/${game.postId}`);
        await expect(page.getByText("Other picks")).toBeVisible();
        await expect(page.getByText(`Picked ${no.label}`)).toBeVisible();
        await expect(page.getByRole("button", { name: "Call BS" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Put money on it" })).toBeVisible();
        await expect(page.getByRole("main")).not.toContainText(/Picked (YES|NO)\b|do not win|Old-style question/);

        // --- Graded: the result is read in the visible choice's words.
        await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: template.yesScore.home, away_score: template.yesScore.away }).eq("id", game.fixtureId);
        const gradedAt = new Date().toISOString();
        await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: gradedAt }).eq("user_id", two.id).eq("market_id", game.marketId);
        await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: gradedAt }).eq("user_id", one.id).eq("market_id", game.marketId);

        await page.goto(`/post/${game.postId}`);
        await expect(page.getByText(`You picked: ${yes.label}`)).toBeVisible();
        await expect(page.getByText("Result: Correct")).toBeVisible();

        // Profile history names the Game + Market and the visible Pick, with the same result.
        await page.goto("/profile");
        const history = page.getByRole("link", { name: `${away} @ ${home} · ${template.marketLabel}` });
        await expect(history).toBeVisible();
        await expect(page.getByText(new RegExp(`You picked ${yes.label.replace(/[+.]/g, "\\$&")} · `))).toBeVisible();
        await expect(page.getByRole("main")).not.toContainText(/You picked (YES|NO)\b/);

        // The other side reads its own visible choice and an incorrect result.
        await loginAs(page, one.email);
        await page.goto(`/post/${game.postId}`);
        await expect(page.getByText(`You picked: ${no.label}`)).toBeVisible();
        await expect(page.getByText("Result: Incorrect")).toBeVisible();

        // The stored Picks and results are exactly what grading wrote: canonical, untouched by presentation.
        const { data: stored } = await admin.from("predictions").select("user_id, selected_outcome, result").eq("market_id", game.marketId);
        expect(stored?.find((p) => p.user_id === two.id)).toMatchObject({ selected_outcome: "YES", result: "CORRECT" });
        expect(stored?.find((p) => p.user_id === one.id)).toMatchObject({ selected_outcome: "NO", result: "INCORRECT" });
      } finally {
        await cleanup(game, [one.id, two.id]);
      }
    });

    test("the logged-out card is the same card: the same labels, as links to sign-up", async ({ page }) => {
      const suffix = randomUUID().slice(0, 8);
      const home = `Hometeam ${suffix}`;
      const away = `Awayteam ${suffix}`;
      const [first, second] = template.choices(home, away);
      // Soon, but still before the T-10 cutoff: the public front door lists the earliest upcoming Games first.
      const game = await seedGame(template, home, away, 25);
      try {
        await page.context().clearCookies();
        await page.goto("/");
        const card = article(page, home, away);
        await expect(card).toBeVisible();
        const picks = card.getByTestId("public-pick-choices").getByRole("link");
        await expect(picks).toHaveText([first.label, second.label]);
        await expect(picks.nth(0)).toHaveAttribute("aria-label", `${first.name} (create an account to make your pick)`);
        await expect(picks.nth(1)).toHaveAttribute("aria-label", `${second.name} (create an account to make your pick)`);
        await expect(card).not.toContainText(/do not win|Will the|Old-style question|\bYes\b/);
      } finally {
        await cleanup(game, []);
      }
    });

    for (const width of [320, 375, 1280]) {
      test(`${width}px: long team names wrap, both choices stay inside the card and tappable, and nothing scrolls sideways`, async ({ page }) => {
        const suffix = randomUUID().slice(0, 8);
        const home = `The Extraordinarily Long Named Football Club of Greater Metropolis United ${suffix}`;
        const away = `Another Remarkably Lengthy Athletic Association of the Northern Territories ${suffix}`;
        const [first, second] = template.choices(home, away);
        const game = await seedGame(template, home, away);
        const user = await createPlayer("narrow");
        try {
          await page.setViewportSize({ width, height: 800 });
          await loginAs(page, user.email);
          await page.goto("/feed");
          const card = article(page, home, away);
          await expect(card).toBeVisible();
          for (const choice of [first, second]) {
            const button = card.getByRole("button", { name: choice.name, exact: true });
            await expect(button).toBeVisible();
            const box = (await button.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            // …and inside the card itself, not merely inside the window (the card clips overflow at desktop widths).
            const cardBox = (await card.boundingBox())!;
            expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
            expect(box.height).toBeGreaterThanOrEqual(36); // a comfortable tap target, wrapped onto lines rather than clipped
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow).toBeLessThanOrEqual(0);

          // The Post detail page reads the same way at this width.
          await page.goto(`/post/${game.postId}`);
          const detailOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(detailOverflow).toBeLessThanOrEqual(0);
        } finally {
          await cleanup(game, [user.id]);
        }
      });
    }
  });
}

// A tied Moneyline resolves VOID (the grading itself is proven through the real jobs in tests/integration/moneyline-tie-void.test.ts).
// This is what a person sees: the same two team labels, "Void", and neither team shown as correct.
test.describe("A tied Moneyline", () => {
  test("keeps both team labels, reads Void on the Post and the Profile, and marks neither team correct", async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const home = `Hometeam ${suffix}`;
    const away = `Awayteam ${suffix}`;
    const moneyline = TEMPLATES.find((t) => t.key === "moneyline")!;
    const game = await seedGame(moneyline, home, away);
    const one = await createPlayer("tieone");
    const two = await createPlayer("tietwo");
    try {
      await loginAs(page, one.email);
      await page.goto("/feed");
      await article(page, home, away).getByRole("button", { name: `Pick ${home} to win`, exact: true }).click();
      await expect.poll(() => storedSelection(one.id, game.marketId)).toBe("YES");
      await loginAs(page, two.email);
      await page.goto("/feed");
      await article(page, home, away).getByRole("button", { name: `Pick ${away} to win`, exact: true }).click();
      await expect.poll(() => storedSelection(two.id, game.marketId)).toBe("NO");

      // 14–14: both stored sides grade VOID, with no resolved side.
      await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 14, away_score: 14 }).eq("id", game.fixtureId);
      await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "VOID", resolved_outcome_snapshot: null, graded_at: new Date().toISOString() }).eq("market_id", game.marketId);

      await page.goto(`/post/${game.postId}`);
      await expect(page.getByText(`You picked: ${away}`)).toBeVisible(); // the visible Pick is unchanged
      await expect(page.getByText(/^Result: Void/)).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/Result: (Correct|Incorrect)/);

      await page.goto("/profile");
      await expect(page.getByText(new RegExp(`You picked ${away}`))).toBeVisible();
      await expect(page.getByText("Void", { exact: true })).toBeVisible();
      await expect(page.getByText(/^(Correct|Incorrect)$/)).toHaveCount(0);

      // The other side of the same tied game reads the same way.
      await loginAs(page, one.email);
      await page.goto(`/post/${game.postId}`);
      await expect(page.getByText(`You picked: ${home}`)).toBeVisible();
      await expect(page.getByText(/^Result: Void/)).toBeVisible();
    } finally {
      await cleanup(game, [one.id, two.id]);
    }
  });
});
