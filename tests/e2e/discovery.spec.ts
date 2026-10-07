/**
 * E2E coverage for Phase D's new Discovery surface (`/discovery`) — the
 * real Sports/Leagues/Teams tabs into the canonical Community graph.
 * Requires the local Supabase stack (`pnpm supabase:start`) — `pnpm
 * test:e2e` handles the rest.
 *
 * Every seeded record embeds this test's unique suffix, same convention
 * as tests/e2e/home-feed.spec.ts, to avoid collisions with other
 * concurrently-running E2E workers' own seeded Communities.
 */
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

const admin = getTestAdminClient();
const PASSWORD = "e2e-password-123";
const PROVIDER = "e2e_discovery";

async function createPlayer(email: string) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin.from("user_profiles").insert({
    id: data.user.id,
    display_name: email.split("@")[0],
    username: `e2edisc${Date.now()}${Math.floor(Math.random() * 1000)}`,
    role: "player",
    is_active: true,
  });
  if (profileError) throw profileError;
  return data.user.id as string;
}

async function loginAs(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/feed$/);
}

async function seedTeamCommunity(name: string, logoUrl: string | null = null) {
  const { data: team, error: teamError } = await admin
    .from("teams")
    .insert({ provider: PROVIDER, external_id: `team-${randomUUID()}`, name, logo_url: logoUrl })
    .select("id")
    .single();
  if (teamError || !team) throw teamError ?? new Error("failed to create team");

  const { data: community, error: communityError } = await admin
    .from("communities")
    .insert({ type: "TEAM", team_id: team.id, slug: `e2e-disc-team-${randomUUID()}`, active: true })
    .select("id, slug")
    .single();
  if (communityError || !community) throw communityError ?? new Error("failed to create community");

  return { teamId: team.id as string, communityId: community.id as string, slug: community.slug as string };
}

async function cleanupTeamCommunity(teamId: string, communityId: string) {
  await admin.from("community_follows").delete().eq("community_id", communityId);
  await admin.from("communities").delete().eq("id", communityId);
  await admin.from("teams").delete().eq("id", teamId);
}

test.describe("Discovery", () => {
  test("has exactly the 3 locked tabs and no others", async ({ page }) => {
    const email = `e2e-disc-tabs-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);
    await page.goto("/discovery");

    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(page.getByRole("tab", { name: "Sports" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Leagues" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Teams" })).toBeVisible();
  });

  test("the Sports tab shows each sport's own icon next to its name (no crest exists for a sport), and the same icon on its Community page", async ({ page }) => {
    const suffix = randomUUID().slice(0, 8);
    const sportKey = "hockey";
    const { data: existing } = await admin.from("communities").select("id").eq("type", "SPORT").eq("sport_key", sportKey).maybeSingle();
    let createdId: string | null = null;
    let slug = "hockey";
    if (!existing) {
      const { data: created } = await admin.from("communities").insert({ type: "SPORT", sport_key: sportKey, slug: `hockey-e2e-${suffix}`, display_name: "Hockey", active: true }).select("id, slug").single();
      createdId = created!.id;
      slug = created!.slug;
    } else {
      slug = (await admin.from("communities").select("slug").eq("id", existing.id).single()).data!.slug;
    }
    const email = `e2e-disc-sporticon-${suffix}@example.com`;
    await createPlayer(email);
    try {
      await loginAs(page, email);
      await page.goto("/discovery");
      const row = page.getByRole("listitem").filter({ hasText: "Hockey" }).first();
      await expect(row.getByTestId("sport-icon")).toBeVisible();
      await expect(row.getByTestId("sport-icon")).toHaveAttribute("data-sport", "hockey");
      const box = (await row.getByTestId("sport-icon").boundingBox())!;
      expect(box.width).toBeGreaterThan(8); // really drawn, not collapsed
      await page.goto(`/community/${slug}`);
      await expect(page.getByTestId("sport-icon").first()).toHaveAttribute("data-sport", "hockey");
    } finally {
      if (createdId) await admin.from("communities").delete().eq("id", createdId);
    }
  });

  test("clicking a tab (client-side navigation, not a fresh page load) actually swaps the list content", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Client Nav Team ${suffix}`;
    const { teamId, communityId } = await seedTeamCommunity(teamName);

    const email = `e2e-disc-clientnav-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      // Loads Sports (the default tab) via a real page load, then clicks
      // Teams — a client-side transition, not another page.goto — since
      // that's the only way to exercise DiscoveryTabNav's own
      // router.push()/router.refresh() handler rather than always hitting
      // a fresh server render directly.
      await page.goto("/discovery");
      await expect(page.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");

      await page.getByRole("tab", { name: "Teams" }).click();
      await expect(page).toHaveURL(/tab=teams/);
      await expect(page.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("link", { name: teamName })).toBeVisible();
    } finally {
      await cleanupTeamCommunity(teamId, communityId);
    }
  });

  test("the Teams tab shows a real, seeded Team Community, linking to its canonical Community page", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Discovery Team ${suffix}`;
    const { teamId, communityId, slug } = await seedTeamCommunity(teamName);

    const email = `e2e-disc-team-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto("/discovery?tab=teams");
      await expect(page.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");

      const row = page.getByRole("link", { name: teamName });
      await expect(row).toBeVisible();
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/community/${slug}$`));
      await expect(page.getByText(teamName)).toBeVisible();
    } finally {
      await cleanupTeamCommunity(teamId, communityId);
    }
  });

  test("never leaks the raw CommunityType enum on any tab", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E No Enum Team ${suffix}`;
    const { teamId, communityId } = await seedTeamCommunity(teamName);

    const email = `e2e-disc-enum-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto("/discovery?tab=teams");
      await expect(page.getByText(teamName)).toBeVisible();
      await expect(page.getByText(/^\s*TEAM\s*$/)).toHaveCount(0);
      await expect(page.getByText(/^\s*LEAGUE\s*$/)).toHaveCount(0);
      await expect(page.getByText(/^\s*SPORT\s*$/)).toHaveCount(0);
    } finally {
      await cleanupTeamCommunity(teamId, communityId);
    }
  });

  test("a zero-follow user still sees the full Teams catalog — following never gates Discovery", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Zero Follow Discovery Team ${suffix}`;
    const { teamId, communityId } = await seedTeamCommunity(teamName);

    const email = `e2e-disc-zero-${suffix}@example.com`;
    await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto("/discovery?tab=teams");
      await expect(page.getByText(teamName)).toBeVisible();
      await expect(page.getByRole("button", { name: "Follow" }).first()).toBeVisible();
    } finally {
      await cleanupTeamCommunity(teamId, communityId);
    }
  });

  test("following a Team from Discovery updates its state without leaving the page", async ({ page }) => {
    const suffix = randomUUID();
    const teamName = `E2E Follow Action Team ${suffix}`;
    const { teamId, communityId } = await seedTeamCommunity(teamName);

    const email = `e2e-disc-follow-${suffix}@example.com`;
    const userId = await createPlayer(email);

    try {
      await loginAs(page, email);
      await page.goto("/discovery?tab=teams");

      const row = page.locator("li", { hasText: teamName });
      await expect(row.getByRole("button", { name: "Follow" })).toBeVisible();
      await row.getByRole("button", { name: "Follow" }).click();

      // CommunityFollowButton sets its optimistic "Following" label
      // synchronously and only clears `disabled` once the server action
      // inside its useTransition actually resolves — wait for that, not
      // just the optimistic label, before asserting on the DB.
      const followingButton = row.getByRole("button", { name: "Following" });
      await expect(followingButton).toBeVisible();
      await expect(followingButton).toBeEnabled();

      const { data } = await admin.from("community_follows").select("id").eq("user_id", userId).eq("community_id", communityId).maybeSingle();
      expect(data).not.toBeNull();
    } finally {
      await cleanupTeamCommunity(teamId, communityId);
    }
  });

  test("the primary nav's Discovery tab points at /discovery and marks it active", async ({ page }) => {
    const email = `e2e-disc-nav-${randomUUID()}@example.com`;
    await createPlayer(email);
    await loginAs(page, email);
    await page.goto("/discovery");

    const discoveryLink = page.getByRole("link", { name: /discovery/i });
    await expect(discoveryLink).toHaveAttribute("href", "/discovery");
    await expect(discoveryLink).toHaveAttribute("aria-current", "page");
  });
});
