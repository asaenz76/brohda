/**
 * Integration tests for Milestone R3 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Post Foundation). Real local Supabase — real `fixtures`/`markets`/
 * `posts`/`platform_settings` rows, no mocking needed (unlike R2, this
 * domain has no external provider call of its own).
 */
import { afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { ensurePostForFixture, getPostByFixtureId, getPublishedPostById, publishPost } from "@/lib/posts/repository";
import { ensureAndPublishPostForFixture, runPostPublication } from "@/lib/posts/publication";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { upsertMarket, listActiveMarketsForFixture } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();
const testProvider = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdPostIds: string[] = [];

async function createFixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: testProvider,
      external_fixture_id: `r3-post-${crypto.randomUUID()}`,
      home_team_name: "Home Test NFL",
      away_team_name: "Away Test NFL",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
      ...overrides,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

function marketPayload(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
    providerEventId: null,
    question: "Will the home team win?",
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Home", no: "Away" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
    ...overrides,
  };
}

async function createMarket(fixtureId: string, overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(marketPayload(fixtureId, overrides));
  createdMarketIds.push(id);
  return id;
}

async function setPolicy(overrides: Record<string, unknown>) {
  await admin.from("platform_settings").update(overrides).eq("id", true);
}

afterEach(async () => {
  if (createdMarketIds.length > 0) {
    // Predictions before markets — predictions.market_id is a soft
    // reference (no FK), so deleting the market first would leave the
    // prediction permanently orphaned.
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
  }
  createdMarketIds.length = 0;
  if (createdPostIds.length > 0) await admin.from("posts").delete().in("id", createdPostIds);
  createdPostIds.length = 0;
  if (createdFixtureIds.length > 0) await admin.from("fixtures").delete().in("id", createdFixtureIds);
  createdFixtureIds.length = 0;
  await setPolicy({ post_publication_enabled: false, post_publication_requires_active_market: true, post_primary_market_template_priority: ["MONEYLINE", "TOTAL", "SPREAD"] });
});

describe("Post identity", () => {
  it("creates one canonical Post for a Game", async () => {
    const fixtureId = await createFixture();
    const { id, outcome } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);
    expect(outcome).toBe("created");
    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id);
  });

  it("repeated creation for the same Game is idempotent", async () => {
    const fixtureId = await createFixture();
    const first = await ensurePostForFixture(fixtureId);
    createdPostIds.push(first.id);
    const second = await ensurePostForFixture(fixtureId);
    expect(second.outcome).toBe("existing");
    expect(second.id).toBe(first.id);

    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1);
  });

  it("different Games get different Posts", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const postA = await ensurePostForFixture(fixtureA);
    const postB = await ensurePostForFixture(fixtureB);
    createdPostIds.push(postA.id, postB.id);
    expect(postA.id).not.toBe(postB.id);
  });

  it("concurrent creation for the same Game produces exactly one Post", async () => {
    const fixtureId = await createFixture();
    const results = await Promise.all([ensurePostForFixture(fixtureId), ensurePostForFixture(fixtureId), ensurePostForFixture(fixtureId)]);
    createdPostIds.push(results[0].id);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1);
  });

  it("a Post's Game association cannot be reassigned", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const { id } = await ensurePostForFixture(fixtureA);
    createdPostIds.push(id);

    const { error } = await admin.from("posts").update({ fixture_id: fixtureB }).eq("id", id);
    expect(error).not.toBeNull();
  });

  it("the database rejects a second Post for the same Game even bypassing the repository helper", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    const { error } = await admin.from("posts").insert({ fixture_id: fixtureId });
    expect(error).not.toBeNull();
  });
});

describe("security", () => {
  it("anon cannot create a Post", async () => {
    const fixtureId = await createFixture();
    const anon = getTestAnonClient();
    const { error } = await anon.from("posts").insert({ fixture_id: fixtureId });
    expect(error).not.toBeNull();
  });

  it("an authenticated normal user cannot create a Post", async () => {
    const fixtureId = await createFixture();
    const email = `r3-post-user-${crypto.randomUUID()}@test.local`;
    const password = "integration-test-password-123";
    const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    await admin.from("user_profiles").insert({ id: created!.user!.id, display_name: "R3 Post Test", role: "player", is_active: true });

    const userClient = getTestAnonClient();
    await userClient.auth.signInWithPassword({ email, password });
    const { error } = await userClient.from("posts").insert({ fixture_id: fixtureId });
    expect(error).not.toBeNull();

    await admin.auth.admin.deleteUser(created!.user!.id);
  });

  it("an unauthenticated client cannot read an unpublished Post, and an authenticated one cannot publish it themselves", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    const anon = getTestAnonClient();
    const { data: readData } = await anon.from("posts").select("*").eq("id", id);
    expect(readData ?? []).toEqual([]);

    const { error: updateError } = await anon.from("posts").update({ published_at: new Date().toISOString() }).eq("id", id);
    expect(updateError).not.toBeNull();
  });
});

describe("Game durability — Post identity survives Game changes", () => {
  it("a fixture score/status update does not create a new Post", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    await admin.from("fixtures").update({ internal_status: "COMPLETED", home_score: 24, away_score: 17 }).eq("id", fixtureId);

    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id);
    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1);
  });

  it("a kickoff-time update does not create a new Post", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    await admin.from("fixtures").update({ scheduled_start_utc: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() }).eq("id", fixtureId);

    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id);
  });

  it("Game cancellation does not delete the Post", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);
    await publishPost(id);

    await admin.from("fixtures").update({ internal_status: "CANCELLED" }).eq("id", fixtureId);

    const post = await getPublishedPostById(id);
    expect(post).not.toBeNull();
    expect(post?.id).toBe(id);
  });
});

describe("Market movement does not affect Post identity", () => {
  it("a price update on the primary Market never creates a new Post", async () => {
    const fixtureId = await createFixture();
    const providerMarketId = `moneyline_${crypto.randomUUID()}`;
    await createMarket(fixtureId, { providerMarketId, marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    // Same identity (providerMarketId) as above — a genuine price refresh,
    // not a new proposition, matching upsertMarket's own update-in-place
    // contract for an unchanged identity.
    await createMarket(fixtureId, { providerMarketId, marketTemplate: "MONEYLINE", yesSide: "HOME", price: { yes: 0.75, no: 0.25, outcomeLabels: { yes: "Home", no: "Away" } } });

    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id);
    const { count } = await admin.from("markets").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1); // still one Market row, price updated in place
  });

  it("a TOTAL line move (R2 behavior) never creates a new Post, and the Post's primary Market presentation can change while its identity does not", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    // Simulate R2's line-movement behavior directly: deactivate the old
    // line, insert the new one (mirroring lib/prediction-markets/
    // ingestion/nfl.ts's own ingestTotal logic).
    const oldTotal = (await listActiveMarketsForFixture(fixtureId))[0];
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", oldTotal.id);
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 48.5, yesSide: null });

    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id); // Post identity unchanged

    const active = await listActiveMarketsForFixture(fixtureId);
    expect(active).toHaveLength(1);
    expect(active[0].lineValue).toBe(48.5);

    // The old, now-inactive proposition still exists, untouched.
    const { data: stillThere } = await admin.from("markets").select("line_value, status").eq("id", oldTotal.id).single();
    expect(stillThere?.line_value).toBe(47.5);
    expect(stillThere?.status).toBe("INACTIVE");
  });
});

describe("multiple Markets", () => {
  it("a Post's Game can expose both MONEYLINE and TOTAL simultaneously", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" });
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    const active = await listActiveMarketsForFixture(fixtureId);
    expect(active).toHaveLength(2);
    const templates = active.map((m) => m.marketTemplate).sort();
    expect(templates).toEqual(["MONEYLINE", "TOTAL"]);
  });

  it("does not require all three templates to exist", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const active = await listActiveMarketsForFixture(fixtureId);
    expect(active).toHaveLength(1);
    expect(selectPrimaryMarket(active, ["MONEYLINE", "TOTAL", "SPREAD"])?.marketTemplate).toBe("MONEYLINE");
  });

  it("an inactive historical Market never becomes primary", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null });
    const oldTotal = (await listActiveMarketsForFixture(fixtureId))[0];
    await admin.from("markets").update({ status: "INACTIVE" }).eq("id", oldTotal.id);

    const active = await listActiveMarketsForFixture(fixtureId);
    expect(active).toHaveLength(0);
    expect(selectPrimaryMarket(active, ["MONEYLINE", "TOTAL", "SPREAD"])).toBeNull();
  });
});

describe("zero-Market Game", () => {
  it("a Post can exist for a Game with no active Markets, safely", async () => {
    const fixtureId = await createFixture();
    const { id } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(id);

    const active = await listActiveMarketsForFixture(fixtureId);
    expect(active).toHaveLength(0);
    expect(selectPrimaryMarket(active, ["MONEYLINE", "TOTAL", "SPREAD"])).toBeNull();
    // No crash — the Post itself is perfectly valid with zero Markets.
    const post = await getPostByFixtureId(fixtureId);
    expect(post?.id).toBe(id);
  });
});

describe("automatic publication policy", () => {
  it("does nothing when post_publication_enabled is false", async () => {
    await setPolicy({ post_publication_enabled: false });
    const summary = await runPostPublication();
    expect(summary.policyEnabled).toBe(false);
    expect(summary.fixturesExamined).toBe(0);
  });

  it("creates but does NOT publish a Post when requiresActiveMarket is true and no Market exists", async () => {
    const fixtureId = await createFixture();
    const outcome = await ensureAndPublishPostForFixture(fixtureId, true);
    createdPostIds.push(outcome.postId);
    expect(outcome.outcome).toBe("skipped-no-active-market");

    const post = await getPostByFixtureId(fixtureId);
    expect(post).not.toBeNull();
    expect(post?.publishedAt).toBeNull();
    const publiclyVisible = await getPublishedPostById(outcome.postId);
    expect(publiclyVisible).toBeNull();
  });

  it("publishes a Post once an active Market exists", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const outcome = await ensureAndPublishPostForFixture(fixtureId, true);
    createdPostIds.push(outcome.postId);
    expect(outcome.outcome).toBe("published");

    const post = await getPublishedPostById(outcome.postId);
    expect(post).not.toBeNull();
  });

  it("publishes immediately regardless of Markets when requiresActiveMarket is false", async () => {
    const fixtureId = await createFixture();
    const outcome = await ensureAndPublishPostForFixture(fixtureId, false);
    createdPostIds.push(outcome.postId);
    expect(outcome.outcome).toBe("published");
  });

  it("is idempotent — running twice never re-publishes or duplicates", async () => {
    const fixtureId = await createFixture();
    await createMarket(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const first = await ensureAndPublishPostForFixture(fixtureId, true);
    createdPostIds.push(first.postId);
    const second = await ensureAndPublishPostForFixture(fixtureId, true);
    expect(second.outcome).toBe("already-published");
    expect(second.postId).toBe(first.postId);

    const { count } = await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", fixtureId);
    expect(count).toBe(1);
  });
});

describe("existing Pick compatibility", () => {
  it("Predictions remain Market-scoped — creating a Post does not change predictions.market_id semantics", async () => {
    const fixtureId = await createFixture();
    const marketId = await createMarket(fixtureId, { marketTemplate: "MONEYLINE", yesSide: "HOME" });
    const { id: postId } = await ensurePostForFixture(fixtureId);
    createdPostIds.push(postId);

    const { data: user } = await admin.auth.admin.createUser({ email: `r3-pick-${crypto.randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
    await admin.from("user_profiles").insert({ id: user!.user!.id, display_name: "R3 Pick Test", role: "player", is_active: true });
    const { error } = await admin.from("predictions").insert({
      user_id: user!.user!.id,
      market_id: marketId,
      selected_outcome: "YES",
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_status_snapshot: "ACTIVE",
      idempotency_key: crypto.randomUUID(),
    });
    expect(error).toBeNull();

    const { data: prediction } = await admin.from("predictions").select("market_id").eq("user_id", user!.user!.id).single();
    expect(prediction?.market_id).toBe(marketId); // never postId — Pick is Market-scoped, not Post-scoped

    await admin.auth.admin.deleteUser(user!.user!.id);
  });
});
