/**
 * "SEE MORE MARKETS" is driven by data: the feed counts the Game's OTHER displayable Markets — the very set the Post page lists — so hidden, archived or
 * otherwise ineligible Markets never trigger it, and no sport is special-cased.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame } from "./helpers/game-seed";
import { getSocialFeed } from "@/lib/communities/feed";

const admin = getTestAdminClient();

async function publishedGame(sport: string, extra: Array<{ template: "SPREAD" | "TOTAL" | "MONEYLINE"; status: string }> = []) {
  const { fixtureId } = await seedGame({ sport, startsInMinutes: 24 * 60 });
  const { data: first } = await admin.from("markets").select("provider").eq("fixture_id", fixtureId).single();
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  for (const m of extra) {
    const { error } = await admin.from("markets").insert({
      provider: first!.provider, provider_market_id: `more_${randomUUID()}`, question: "q?", status: m.status, fixture_id: fixtureId, yes_price: 0.5, no_price: 0.5, liquidity: 100,
      last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {}, market_template: m.template, yes_side: m.template === "TOTAL" ? null : "HOME", line_value: m.template === "MONEYLINE" ? null : 3.5,
    });
    if (error) throw error;
  }
  return post!.id as string;
}
const countFor = async (postId: string) => (await getSocialFeed(null, 300)).find((i) => i.post.id === postId)?.moreMarketsCount;

describe("moreMarketsCount on the feed item", () => {
  it("one Market → 0; two → 1; three → 2 (the primary Market is never counted as 'more')", async () => {
    const one = await publishedGame("american_football");
    const two = await publishedGame("american_football", [{ template: "TOTAL", status: "ACTIVE" }]);
    const three = await publishedGame("american_football", [{ template: "TOTAL", status: "ACTIVE" }, { template: "SPREAD", status: "ACTIVE" }]);
    expect([await countFor(one), await countFor(two), await countFor(three)]).toEqual([0, 1, 2]);
  });

  it("hidden / ineligible extra Markets do not count: only the statuses the Post page displays (ACTIVE, CLOSED)", async () => {
    const post = await publishedGame("american_football", [
      { template: "TOTAL", status: "ARCHIVED" },
      { template: "SPREAD", status: "INACTIVE" },
    ]);
    expect(await countFor(post)).toBe(0);
    const { data: fx } = await admin.from("posts").select("fixture_id").eq("id", post).single();
    await admin.from("markets").insert({ provider: "api_nfl", provider_market_id: `closed_${randomUUID()}`, question: "q", status: "CLOSED", fixture_id: fx!.fixture_id, yes_price: 0.5, no_price: 0.5, liquidity: 1, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {}, market_template: "TOTAL", yes_side: null, line_value: 40.5 });
    expect(await countFor(post)).toBe(1); // a CLOSED Market is listed on the Post, so it counts
  });

  it("is sport-agnostic: the same data gives the same answer for every sport", async () => {
    for (const sport of ["american_football", "basketball", "hockey"]) {
      const post = await publishedGame(sport, [{ template: "TOTAL", status: "ACTIVE" }]);
      expect(await countFor(post), sport).toBe(1);
    }
  });
});
