/**
 * NBA and NHL in a real browser, on the SAME Game Post / Market / Pick / Call BS / grading architecture the NFL uses. One spec body per sport
 * and template: the Post renders in the sport's own matchup order and language; there is no crowd sentiment before a Pick; a Pick works, survives
 * a reload, and can change before T-10; an opposing Pick opens the Call BS / money affordances on the visible choices; sentiment (percentages and
 * a count) appears only after a Pick; the Game locks at T-10; and a graded Game reads in the visible choice's words. Seeded through the app's own
 * tables with controlled fixtures; no real money, test accounts only.
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
interface TemplateCase {
  key: "moneyline" | "spread" | "total";
  marketLabel: string;
  market: { market_template: string; yes_side: string | null; line_value: number | null };
  choices: (home: string, away: string) => [Choice, Choice];
  yesScore: [number, number];
}
interface SportCase {
  sport: "basketball" | "hockey";
  provider: "api_nba" | "api_nhl";
  league: string;
  home: string;
  away: string;
  templates: TemplateCase[];
}

const NBA: SportCase = {
  sport: "basketball",
  provider: "api_nba",
  league: "NBA",
  home: "Boston Celtics",
  away: "Los Angeles Lakers",
  templates: [
    {
      key: "moneyline",
      marketLabel: "Moneyline",
      market: { market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
      choices: (home, away) => [
        { outcome: "NO", label: away, name: `Pick ${away} to win` },
        { outcome: "YES", label: home, name: `Pick ${home} to win` },
      ],
      yesScore: [112, 105],
    },
    {
      key: "spread",
      marketLabel: "Spread",
      market: { market_template: "SPREAD", yes_side: "HOME", line_value: 4.5 },
      choices: (home, away) => [
        { outcome: "NO", label: `${away} -4.5`, name: `Pick ${away} minus 4.5` },
        { outcome: "YES", label: `${home} +4.5`, name: `Pick ${home} plus 4.5` },
      ],
      yesScore: [101, 104], // 101 + 4.5 > 104: the home side covers
    },
    {
      key: "total",
      marketLabel: "Total 228.5",
      market: { market_template: "TOTAL", yes_side: null, line_value: 228.5 },
      choices: () => [
        { outcome: "YES", label: "Over 228.5", name: "Pick Over 228.5 total points" },
        { outcome: "NO", label: "Under 228.5", name: "Pick Under 228.5 total points" },
      ],
      yesScore: [120, 112], // 232 > 228.5
    },
  ],
};

const NHL: SportCase = {
  sport: "hockey",
  provider: "api_nhl",
  league: "NHL",
  home: "Boston Bruins",
  away: "New York Rangers",
  templates: [
    {
      key: "moneyline",
      marketLabel: "Moneyline",
      market: { market_template: "MONEYLINE", yes_side: "HOME", line_value: null },
      choices: (home, away) => [
        { outcome: "NO", label: away, name: `Pick ${away} to win` },
        { outcome: "YES", label: home, name: `Pick ${home} to win` },
      ],
      yesScore: [4, 3], // e.g. decided in overtime or a shootout — the official final is all that matters
    },
    {
      key: "spread",
      marketLabel: "Spread",
      market: { market_template: "SPREAD", yes_side: "HOME", line_value: 1.5 },
      choices: (home, away) => [
        { outcome: "NO", label: `${away} -1.5`, name: `Pick ${away} minus 1.5` },
        { outcome: "YES", label: `${home} +1.5`, name: `Pick ${home} plus 1.5` },
      ],
      yesScore: [2, 3], // 2 + 1.5 > 3: the home side covers the puck line
    },
    {
      key: "total",
      marketLabel: "Total 6.5",
      market: { market_template: "TOTAL", yes_side: null, line_value: 6.5 },
      choices: () => [
        { outcome: "YES", label: "Over 6.5", name: "Pick Over 6.5 total goals" }, // goals, never "points"
        { outcome: "NO", label: "Under 6.5", name: "Pick Under 6.5 total goals" },
      ],
      yesScore: [5, 3], // 8 > 6.5
    },
  ],
};

async function createPlayer(label: string) {
  const email = `e2e-multisport-${label}-${randomUUID()}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: `${label}${Math.floor(Math.random() * 100000)}`,
    username: `ms${label}${Date.now()}${Math.floor(Math.random() * 1000)}`,
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

async function seedGame(sport: SportCase, template: TemplateCase, home: string, away: string, startsInMinutes = 24 * 60) {
  const { data: fixture, error: fixtureError } = await admin
    .from("fixtures")
    .insert({
      provider: sport.provider,
      external_fixture_id: `e2e-multisport-${randomUUID()}`,
      sport: sport.sport,
      home_team_name: home,
      away_team_name: away,
      competition_name: sport.league,
      competition_external_id: sport.provider === "api_nba" ? "12" : "57",
      scheduled_start_utc: new Date(Date.now() + startsInMinutes * 60_000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (fixtureError || !fixture) throw fixtureError ?? new Error("failed to create fixture");
  const { data: market, error: marketError } = await admin
    .from("markets")
    .insert({
      provider: sport.provider,
      provider_market_id: `ms_${randomUUID()}`,
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
    .select("id")
    .single();
  if (marketError || !market) throw marketError ?? new Error("failed to create market");
  const { data: post, error: postError } = await admin.from("posts").insert({ fixture_id: fixture.id, published_at: new Date().toISOString() }).select("id").single();
  if (postError || !post) throw postError ?? new Error("failed to create post");
  return { fixtureId: fixture.id as string, marketId: market.id as string, postId: post.id as string };
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

for (const sport of [NBA, NHL]) {
  for (const template of sport.templates) {
    test.describe(`${sport.league} ${template.marketLabel} Game Post`, () => {
      test("renders in the sport's matchup order and language, hides sentiment until a Pick, then runs the whole Pick -> Call BS -> graded loop on the shared architecture", async ({ page }) => {
        const suffix = randomUUID().slice(0, 6);
        const home = `${sport.home} ${suffix}`;
        const away = `${sport.away} ${suffix}`;
        const [first, second] = template.choices(home, away);
        const yes = [first, second].find((c) => c.outcome === "YES")!;
        const no = [first, second].find((c) => c.outcome === "NO")!;
        const game = await seedGame(sport, template, home, away);
        const one = await createPlayer("one");
        const two = await createPlayer("two");
        try {
          await loginAs(page, one.email);
          await page.goto("/feed");
          const card = article(page, home, away);
          await expect(card).toBeVisible();
          // Away @ Home for every one of these sports, from the shared matchup helper; the league and the sport's own labels.
          await expect(card.getByText(`${away} @ ${home}`)).toBeVisible();
          await expect(card.locator('[data-slot="league-identity"]')).toHaveText(sport.league);
          const picker = card.getByTestId("prediction-actions");
          await expect(picker.getByRole("button")).toHaveText([first.label, second.label]);
          await expect(picker.getByRole("button", { name: first.name, exact: true })).toBeVisible();
          await expect(picker.getByRole("button", { name: second.name, exact: true })).toBeVisible();
          await expect(picker).not.toContainText(/\bYes\b|\bNo\b/);
          await expect(card).not.toContainText(/do not win|Will the|Old-style question|kickoff|touchdown/i);
          if (template.key === "total") await expect(card.getByText(template.marketLabel, { exact: true })).toBeVisible();

          // NO sentiment before a Pick: no percentages and no count — only the nudge.
          await expect(card.getByText("Make your pick to see how everyone else picked.")).toBeVisible();
          expect(await card.innerText()).not.toMatch(/\d+%|\d+ predicted/);

          // Pick -> stored canonical selection, reload preserves, change before T-10 moves both.
          await card.getByRole("button", { name: yes.name, exact: true }).click();
          await expect.poll(() => storedSelection(one.id, game.marketId)).toBe("YES");
          await page.reload();
          await expect(card.getByRole("button", { name: yes.name, exact: true })).toHaveAttribute("aria-pressed", "true");
          await card.getByRole("button", { name: no.name, exact: true }).click();
          await expect(card.getByRole("button", { name: no.name, exact: true })).toHaveAttribute("aria-pressed", "true");
          await expect.poll(() => storedSelection(one.id, game.marketId)).toBe("NO");

          // An opposing participant picks the other visible side; sentiment now reveals for them (percentages + count), in display order.
          await loginAs(page, two.email);
          await page.goto("/feed");
          await expect(card.getByText("Make your pick to see how everyone else picked.")).toBeVisible();
          await card.getByRole("button", { name: yes.name, exact: true }).click();
          await expect.poll(() => storedSelection(two.id, game.marketId)).toBe("YES");
          await page.reload();
          await expect(card.getByText(`${first.label} 50% · ${second.label} 50% · 2 predicted`)).toBeVisible();

          // The Post: the other Pick in the visible words, and the Call BS / money affordances on opposing visible choices.
          await page.goto(`/post/${game.postId}`);
          await expect(page.getByText("Other picks")).toBeVisible();
          await expect(page.getByText(`Picked ${no.label}`)).toBeVisible();
          await expect(page.getByRole("button", { name: "Call BS" })).toBeVisible();
          await expect(page.getByRole("button", { name: "Put money on it" })).toBeVisible();
          await expect(page.getByRole("main")).not.toContainText(/Picked (YES|NO)\b|do not win|Old-style question/);

          // Graded: the official final is the whole story; the result reads in the visible choice's words.
          await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: template.yesScore[0], away_score: template.yesScore[1] }).eq("id", game.fixtureId);
          const gradedAt = new Date().toISOString();
          await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: gradedAt }).eq("user_id", two.id).eq("market_id", game.marketId);
          await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: gradedAt }).eq("user_id", one.id).eq("market_id", game.marketId);
          await page.goto(`/post/${game.postId}`);
          await expect(page.getByText(`You picked: ${yes.label}`)).toBeVisible();
          await expect(page.getByText("Result: Correct")).toBeVisible();
          await page.goto("/profile");
          await expect(page.getByRole("link", { name: `${away} @ ${home} · ${template.marketLabel}` })).toBeVisible();
          await expect(page.getByText(new RegExp(`You picked ${yes.label.replace(/[+.]/g, "\\$&")} · `))).toBeVisible();
          await expect(page.getByRole("main")).not.toContainText(/You picked (YES|NO)\b/);
        } finally {
          await cleanup(game, [one.id, two.id]);
        }
      });

      test("the logged-out card is the same card — same labels as sign-up links, and NO sentiment", async ({ page }) => {
        const suffix = randomUUID().slice(0, 6);
        const home = `${sport.home} ${suffix}`;
        const away = `${sport.away} ${suffix}`;
        const [first, second] = template.choices(home, away);
        const game = await seedGame(sport, template, home, away, 25);
        try {
          await page.context().clearCookies();
          await page.goto("/");
          const card = article(page, home, away);
          await expect(card).toBeVisible();
          await expect(card.getByTestId("public-pick-choices").getByRole("link")).toHaveText([first.label, second.label]);
          expect(await card.innerText()).not.toMatch(/\d+%|\d+ predicted/);
          await expect(card).not.toContainText(/do not win|Will the|Old-style question|\bYes\b/);
        } finally {
          await cleanup(game, []);
        }
      });

      for (const width of [320, 375, 768, 1280]) {
        test(`${width}px: long team names wrap, choices stay inside the card and tappable, nothing scrolls sideways (feed, Post, Profile)`, async ({ page }) => {
          const suffix = randomUUID().slice(0, 6);
          const home = `The Extraordinarily Long Named ${sport.league} Franchise of Greater Metropolis ${suffix}`;
          const away = `Another Remarkably Lengthy ${sport.league} Club of the Northern Territories ${suffix}`;
          const [first, second] = template.choices(home, away);
          const game = await seedGame(sport, template, home, away);
          const user = await createPlayer("narrow");
          try {
            await page.setViewportSize({ width, height: 800 });
            await loginAs(page, user.email);
            await page.goto("/feed");
            const card = article(page, home, away);
            await expect(card).toBeVisible();
            for (const choice of [first, second]) {
              const button = card.getByRole("button", { name: choice.name, exact: true });
              const box = (await button.boundingBox())!;
              const cardBox = (await card.boundingBox())!;
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(width);
              expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
              expect(box.height).toBeGreaterThanOrEqual(36);
            }
            await card.getByRole("button", { name: first.name, exact: true }).click(); // after a Pick the sentiment line (long labels) is on screen too
            await expect(card.getByText(/\d+% .* predicted/)).toBeVisible();
            for (const path of ["/feed", `/post/${game.postId}`, "/profile"]) {
              await page.goto(path);
              const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
              expect(overflow, `${path} @ ${width}`).toBeLessThanOrEqual(0);
            }
          } finally {
            await cleanup(game, [user.id]);
          }
        });
      }
    });
  }

  test.describe(`${sport.league} — T-10 and started-game safety`, () => {
    test("inside T-10 the Game is locked in the UI and the server refuses a Pick; a LIVE Game is closed regardless of the clock", async ({ page }) => {
      const suffix = randomUUID().slice(0, 6);
      const moneyline = sport.templates[0];
      const home = `${sport.home} ${suffix}`;
      const away = `${sport.away} ${suffix}`;
      const locked = await seedGame(sport, moneyline, home, away, 5); // five minutes out: inside the 10-minute cutoff
      const user = await createPlayer("lock");
      try {
        await loginAs(page, user.email);
        await page.goto("/feed");
        const card = article(page, home, away);
        await expect(card).toBeVisible();
        // The server is authoritative: tapping a Pick inside T-10 is refused with the shared copy, and nothing is stored.
        await card.getByRole("button", { name: `Pick ${home} to win` }).click();
        await expect(card.getByText("Picks are locked for this game.")).toBeVisible(); // the card swaps the Pick buttons for the lock notice
        expect(await storedSelection(user.id, locked.marketId)).toBeUndefined();
        const { data } = await admin.rpc("set_pick", { p_user_id: user.id, p_market_id: locked.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
        expect((data as { outcome: string }).outcome).toBe("rejected_cutoff");
        expect(await storedSelection(user.id, locked.marketId)).toBeUndefined();
      } finally {
        await cleanup(locked, [user.id]);
      }
    });

    test("a LIVE Game starting days from now is still closed: the server's status, not the wall clock, decides", async ({ page }) => {
      const suffix = randomUUID().slice(0, 6);
      const home = `${sport.home} ${suffix}`;
      const away = `${sport.away} ${suffix}`;
      const game = await seedGame(sport, sport.templates[0], home, away);
      await admin.from("fixtures").update({ internal_status: "LIVE" }).eq("id", game.fixtureId);
      const user = await createPlayer("live");
      try {
        const { data } = await admin.rpc("set_pick", { p_user_id: user.id, p_market_id: game.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
        expect(["rejected_game_closed", "rejected_cutoff"]).toContain((data as { outcome: string }).outcome);
        await loginAs(page, user.email);
        await page.goto(`/post/${game.postId}`);
        await page.getByRole("button", { name: `Pick ${home} to win` }).click();
        await expect(page.getByText(/locked/i).first()).toBeVisible(); // refused on server state alone, days before the scheduled start
        expect(await storedSelection(user.id, game.marketId)).toBeUndefined();
      } finally {
        await cleanup(game, [user.id]);
      }
    });
  });
}

test.describe("Mixed-sport Profile history and admin readability", () => {
  test("one member's history shows NBA and NHL Games together, each in its own words, under the one record", async ({ page }) => {
    const suffix = randomUUID().slice(0, 6);
    const nbaHome = `${NBA.home} ${suffix}`;
    const nbaAway = `${NBA.away} ${suffix}`;
    const nhlHome = `${NHL.home} ${suffix}`;
    const nhlAway = `${NHL.away} ${suffix}`;
    const nba = await seedGame(NBA, NBA.templates[2], nbaHome, nbaAway); // total, points
    const nhl = await seedGame(NHL, NHL.templates[2], nhlHome, nhlAway); // total, goals
    const user = await createPlayer("mixed");
    try {
      for (const [game, pick] of [[nba, "YES"], [nhl, "NO"]] as const) {
        await admin.rpc("set_pick", { p_user_id: user.id, p_market_id: game.marketId, p_selected_outcome: pick, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
      }
      await loginAs(page, user.email);
      await page.goto("/profile");
      await expect(page.getByRole("link", { name: `${nbaAway} @ ${nbaHome} · Total 228.5` })).toBeVisible();
      await expect(page.getByRole("link", { name: `${nhlAway} @ ${nhlHome} · Total 6.5` })).toBeVisible();
      await expect(page.getByText(/You picked Over 228\.5 · /)).toBeVisible();
      await expect(page.getByText(/You picked Under 6\.5 · /)).toBeVisible();
      await expect(page.getByRole("main")).not.toContainText(/per-sport|NBA accuracy|NHL accuracy/i);
    } finally {
      await cleanup(nba, []);
      await cleanup(nhl, [user.id]);
    }
  });

  for (const sport of [NBA, NHL]) {
    test(`admin Predictions reads a ${sport.league} row: username, matchup, Market, the human selected side, canonical YES/NO secondary`, async ({ page }) => {
      const suffix = randomUUID().slice(0, 6);
      const home = `${sport.home} ${suffix}`;
      const away = `${sport.away} ${suffix}`;
      const spread = sport.templates[1];
      const game = await seedGame(sport, spread, home, away);
      const picker = await createPlayer("adminpick");
      const email = `e2e-multisport-admin-${randomUUID()}@test.local`;
      const { data: adminUser } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
      await admin.from("user_profiles").insert({ id: adminUser.user!.id, display_name: "Operator", username: `msop${Date.now()}${Math.floor(Math.random() * 1000)}`, role: "super_admin", is_active: true });
      try {
        await admin.rpc("set_pick", { p_user_id: picker.id, p_market_id: game.marketId, p_selected_outcome: "YES", p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() }).single();
        await loginAs(page, email);
        await page.goto(`/admin/predictions?q=${encodeURIComponent(home)}`);
        const row = page.getByRole("row").filter({ hasText: home });
        await expect(row).toHaveCount(1);
        const cells = row.getByRole("cell");
        await expect(cells.nth(2)).toContainText(`${away} @ ${home}`);
        await expect(cells.nth(3)).toContainText(game.marketId.slice(0, 8)); // the Market, with its short id kept beside it
        await expect(cells.nth(4)).toContainText(`${home} +${spread.market.line_value}`);
        await expect(cells.nth(4)).toContainText("YES");
        // The Events surface lists the Game under its sport.
        await page.goto(`/admin/events?sport=${sport.league.toLowerCase()}`);
        await expect(page.getByRole("main")).toContainText(home);
      } finally {
        await cleanup(game, [picker.id, adminUser.user!.id]);
      }
    });
  }
});
