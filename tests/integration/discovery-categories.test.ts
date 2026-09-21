/**
 * Integration tests for the discovery taxonomy/feed layer
 * (docs/architecture/sports-prediction-network.md). Real local Supabase
 * only (pnpm supabase:start). Covers: taxonomy CRUD, RLS/grant boundaries,
 * feed/category-filter correctness, and the discovery-vs-ingestion
 * eligibility distinction — using markets constructed in-process, never a
 * real network call.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import {
  createCategory,
  createMapping,
  deleteCategory,
  getDiscoveryFeed,
  getMarketDetail,
  getSortPolicy,
  listAllCategories,
  listAllSortRules,
  listEnabledCategories,
  updateSortRule,
} from "@/lib/prediction-markets/discovery/repository";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";

const admin = getTestAdminClient();

const testProvider = `test_discovery_provider_${Date.now()}`;
const createdCategoryIds: string[] = [];
const createdMarketIds: string[] = [];

function marketFixture(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Discovery test market ${providerMarketId}`,
    description: "Test description",
    status: "ACTIVE",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: 100,
    liquidity: 1000,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: new Date(Date.now() + 86_400_000).toISOString(),
    closedAt: null,
    ingestionSource: "integration_test",
    providerMetadata: { _categoryTagsExtracted: [] },
    ...overrides,
  };
}

async function seedMarket(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}) {
  const { id } = await upsertMarket(marketFixture(providerMarketId, overrides));
  createdMarketIds.push(id);
  return id;
}

async function seedCategory(slug: string, displayOrder: number, enabled = true) {
  const category = await createCategory({ slug, displayName: slug, description: null, displayOrder, enabled, iconKey: null });
  createdCategoryIds.push(category.id);
  return category;
}

describe("discovery taxonomy", () => {
  afterAll(async () => {
    if (createdMarketIds.length > 0) await admin.from("markets").delete().in("id", createdMarketIds);
    if (createdCategoryIds.length > 0) await admin.from("discovery_categories").delete().in("id", createdCategoryIds);
  });

  describe("RLS / grant boundaries", () => {
    it("rejects a direct anon write to discovery_categories", async () => {
      const anon = getTestAnonClient();
      const { error } = await anon.from("discovery_categories").insert({ slug: "hacked", display_name: "Hacked", display_order: 0 });
      expect(error).not.toBeNull();
    });

    it("rejects a direct anon read of discovery_categories — no consumer surface reads this table directly", async () => {
      const anon = getTestAnonClient();
      const { data, error } = await anon.from("discovery_categories").select("*").limit(1);
      if (error) expect(error).not.toBeNull();
      else expect(data).toEqual([]);
    });

    it("rejects a direct anon write to discovery_category_provider_mappings", async () => {
      const anon = getTestAnonClient();
      const { error } = await anon.from("discovery_category_provider_mappings").insert({ category_id: "00000000-0000-0000-0000-000000000000", provider: "x", provider_tag: "y" });
      expect(error).not.toBeNull();
    });

    it("still rejects a direct anon write to markets (Milestone 1 protection unaffected by Milestone 2)", async () => {
      const anon = getTestAnonClient();
      const { error } = await anon.from("markets").insert({ provider: testProvider, provider_market_id: "anon-write-attempt", question: "x", status: "ACTIVE", last_synced_at: new Date().toISOString(), ingestion_source: "x" });
      expect(error).not.toBeNull();
    });

    it("allows service-role CRUD on discovery_categories", async () => {
      const category = await seedCategory(`crud-check-${Date.now()}`, 0);
      expect(category.id).toBeTruthy();
    });
  });

  describe("category CRUD and configurability", () => {
    it("creating a category with a brand-new, arbitrary slug requires no source-code change — proven by using a name not referenced anywhere in application code", async () => {
      const category = await seedCategory(`totally-novel-topic-${Date.now()}`, 5);
      const all = await listAllCategories();
      expect(all.some((c) => c.id === category.id)).toBe(true);
    });

    it("enabled categories are listed in configured display order", async () => {
      const suffix = Date.now();
      const c2 = await seedCategory(`order-b-${suffix}`, 20);
      const c1 = await seedCategory(`order-a-${suffix}`, 10);
      const enabled = await listEnabledCategories();
      const idxA = enabled.findIndex((c) => c.id === c1.id);
      const idxB = enabled.findIndex((c) => c.id === c2.id);
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxA).toBeLessThan(idxB);
    });

    it("a disabled category is excluded from listEnabledCategories — this is what makes it disappear from consumer discovery without a deployment", async () => {
      const disabled = await seedCategory(`disabled-${Date.now()}`, 0, false);
      const enabled = await listEnabledCategories();
      expect(enabled.some((c) => c.id === disabled.id)).toBe(false);
      const all = await listAllCategories();
      expect(all.some((c) => c.id === disabled.id)).toBe(true);
    });

    it("deleting a category also removes its mappings (cascade)", async () => {
      const category = await seedCategory(`to-delete-${Date.now()}`, 0);
      const mapping = await createMapping({ categoryId: category.id, provider: testProvider, providerTag: "temp-tag", enabled: true });
      await deleteCategory(category.id);
      createdCategoryIds.splice(createdCategoryIds.indexOf(category.id), 1);

      const { data } = await admin.from("discovery_category_provider_mappings").select("id").eq("id", mapping.id).maybeSingle();
      expect(data).toBeNull();
    });
  });

  describe("provider mapping and discovery eligibility", () => {
    it("a market with a mapped tag appears under its configured category", async () => {
      const suffix = Date.now();
      const category = await seedCategory(`mapped-cat-${suffix}`, 0);
      await createMapping({ categoryId: category.id, provider: testProvider, providerTag: `special-tag-${suffix}`, enabled: true });
      const marketId = await seedMarket(`mapped-market-${suffix}`, { providerMetadata: { _categoryTagsExtracted: [`special-tag-${suffix}`] } });

      const filtered = await getDiscoveryFeed(category.slug);
      expect(filtered.some((m) => m.id === marketId)).toBe(true);

      const all = await getDiscoveryFeed();
      expect(all.some((m) => m.id === marketId)).toBe(true);
    });

    it("an unmapped market fails safely — appears under All, absent from every specific category", async () => {
      const suffix = Date.now();
      const category = await seedCategory(`unrelated-cat-${suffix}`, 0);
      const marketId = await seedMarket(`unmapped-market-${suffix}`, { providerMetadata: { _categoryTagsExtracted: ["some-completely-unmapped-tag"] } });

      const filtered = await getDiscoveryFeed(category.slug);
      expect(filtered.some((m) => m.id === marketId)).toBe(false);

      const all = await getDiscoveryFeed();
      expect(all.some((m) => m.id === marketId)).toBe(true);
    });

    it("a disabled category's slug returns an empty feed rather than throwing — direct access fails gracefully", async () => {
      const disabled = await seedCategory(`disabled-slug-${Date.now()}`, 0, false);
      await expect(getDiscoveryFeed(disabled.slug)).resolves.toEqual([]);
    });

    it("an unknown category slug returns an empty feed rather than throwing", async () => {
      await expect(getDiscoveryFeed("this-slug-does-not-exist-anywhere")).resolves.toEqual([]);
    });

    it("the feed excludes CLOSED and INACTIVE/ARCHIVED markets by default", async () => {
      const suffix = Date.now();
      const activeId = await seedMarket(`active-${suffix}`, { status: "ACTIVE" });
      const closedId = await seedMarket(`closed-${suffix}`, { status: "CLOSED" });
      const archivedId = await seedMarket(`archived-${suffix}`, { status: "ARCHIVED" });

      const feed = await getDiscoveryFeed();
      expect(feed.some((m) => m.id === activeId)).toBe(true);
      expect(feed.some((m) => m.id === closedId)).toBe(false);
      expect(feed.some((m) => m.id === archivedId)).toBe(false);
    });

    it("a market with no usable price still appears in the feed, honestly unpriced", async () => {
      const marketId = await seedMarket(`no-price-${Date.now()}`, { price: { yes: null, no: null, outcomeLabels: null } });
      const feed = await getDiscoveryFeed();
      const card = feed.find((m) => m.id === marketId);
      expect(card).toBeDefined();
      expect(card!.yesPercent).toBeNull();
      expect(card!.noPercent).toBeNull();
      expect(card!.freshness).toBe("UNAVAILABLE");
    });

    it("a market synced long ago is classified STALE or UNAVAILABLE in the feed, never silently shown as FRESH", async () => {
      const marketId = await seedMarket(`stale-${Date.now()}`);
      // Force last_synced_at into the past directly — upsertMarket always stamps "now".
      await admin.from("markets").update({ last_synced_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }).eq("id", marketId);

      const feed = await getDiscoveryFeed();
      const card = feed.find((m) => m.id === marketId);
      expect(card).toBeDefined();
      expect(card!.freshness).toBe("UNAVAILABLE");
    });

    it("freshness classification is genuinely configurable via platform_settings — no source change required (standing hard-coding rule)", async () => {
      const marketId = await seedMarket(`configurable-freshness-${Date.now()}`);
      // 90 minutes old — FRESH under the default 60-minute window.
      await admin.from("markets").update({ last_synced_at: new Date(Date.now() - 90 * 60_000).toISOString() }).eq("id", marketId);

      const { data: before } = await admin.from("platform_settings").select("discovery_fresh_within_minutes").eq("id", true).single();
      const originalFreshWindow = before!.discovery_fresh_within_minutes;

      const beforeFeed = await getDiscoveryFeed();
      expect(beforeFeed.find((m) => m.id === marketId)!.freshness).toBe("STALE");

      // Widen the fresh window past 90 minutes purely via a data change.
      await admin.from("platform_settings").update({ discovery_fresh_within_minutes: 120 }).eq("id", true);
      try {
        const afterFeed = await getDiscoveryFeed();
        expect(afterFeed.find((m) => m.id === marketId)!.freshness).toBe("FRESH");
      } finally {
        await admin.from("platform_settings").update({ discovery_fresh_within_minutes: originalFreshWindow }).eq("id", true);
      }
    });
  });

  describe("market detail", () => {
    it("returns a detail view for an ACTIVE market", async () => {
      const marketId = await seedMarket(`detail-active-${Date.now()}`);
      const detail = await getMarketDetail(marketId);
      expect(detail).not.toBeNull();
      expect(detail!.status).toBe("ACTIVE");
    });

    it("returns a detail view for a CLOSED market, correctly NOT labeled RESOLVED without a real outcome", async () => {
      const marketId = await seedMarket(`detail-closed-${Date.now()}`, { status: "CLOSED" });
      const detail = await getMarketDetail(marketId);
      expect(detail).not.toBeNull();
      expect(detail!.status).toBe("CLOSED");
      expect(detail!.resolvedOutcome).toBeNull();
    });

    it("returns null for an ARCHIVED market — same as a nonexistent id", async () => {
      const marketId = await seedMarket(`detail-archived-${Date.now()}`, { status: "ARCHIVED" });
      expect(await getMarketDetail(marketId)).toBeNull();
    });

    it("returns null for a genuinely nonexistent id", async () => {
      expect(await getMarketDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  describe("legacy isolation", () => {
    it("does not touch legacy pool tables — a spot check that pools remains queryable and unaffected", async () => {
      const { error } = await admin.from("pools").select("id").limit(1);
      expect(error).toBeNull();
    });
  });

  describe("discovery sort policy (hard-coding remediation Finding 1)", () => {
    // discovery_sort_policy has exactly 3 rows total (one per fixed
    // criterion) and is shared across the whole suite — same class of
    // "one real, mutable, shared row" concern this codebase already
    // documents for platform_settings. Every test restores the exact rows
    // it touched, regardless of pass/fail.
    afterEach(async () => {
      await updateSortRule("FRESHNESS", { priority: 0, direction: "ASC", enabled: true });
      await updateSortRule("CLOSE_TIME", { priority: 1, direction: "ASC", enabled: true });
      await updateSortRule("LIQUIDITY", { priority: 2, direction: "DESC", enabled: true });
    });

    it("rejects a direct anon write to discovery_sort_policy", async () => {
      const anon = getTestAnonClient();
      const { error } = await anon.from("discovery_sort_policy").update({ enabled: false }).eq("criterion", "LIQUIDITY");
      expect(error).not.toBeNull();
    });

    it("the default configured policy reproduces original Milestone 2 behavior: freshness, then close time, then liquidity", async () => {
      const policy = await getSortPolicy();
      expect(policy).toEqual([
        { criterion: "FRESHNESS", direction: "ASC" },
        { criterion: "CLOSE_TIME", direction: "ASC" },
        { criterion: "LIQUIDITY", direction: "DESC" },
      ]);
    });

    it("changing the configured priority order changes real getDiscoveryFeed output, with no source change", async () => {
      const suffix = Date.now();
      const soonButStale = await seedMarket(`sort-soon-stale-${suffix}`, { closesAt: new Date(Date.now() + 3_600_000).toISOString() });
      await admin.from("markets").update({ last_synced_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }).eq("id", soonButStale);
      const laterButFresh = await seedMarket(`sort-later-fresh-${suffix}`, { closesAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });

      // Default: freshness first -> laterButFresh (FRESH) ranks before soonButStale (STALE).
      const defaultOrder = await getDiscoveryFeed();
      const defaultIds = defaultOrder.map((m) => m.id).filter((id) => id === soonButStale || id === laterButFresh);
      expect(defaultIds).toEqual([laterButFresh, soonButStale]);

      // Reconfigure: close time first, freshness second — purely a data change.
      await updateSortRule("CLOSE_TIME", { priority: 0 });
      await updateSortRule("FRESHNESS", { priority: 1 });

      const reconfiguredOrder = await getDiscoveryFeed();
      const reconfiguredIds = reconfiguredOrder.map((m) => m.id).filter((id) => id === soonButStale || id === laterButFresh);
      expect(reconfiguredIds).toEqual([soonButStale, laterButFresh]);
    });

    it("disabling a criterion changes real getDiscoveryFeed output, with no source change", async () => {
      const suffix = Date.now();
      const highLiquidityStale = await seedMarket(`sort-disable-a-${suffix}`, { liquidity: 1_000_000 });
      await admin.from("markets").update({ last_synced_at: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }).eq("id", highLiquidityStale);
      const lowLiquidityFresh = await seedMarket(`sort-disable-b-${suffix}`, { liquidity: 1 });

      const withFreshnessEnabled = await getDiscoveryFeed();
      const idsBefore = withFreshnessEnabled.map((m) => m.id).filter((id) => id === highLiquidityStale || id === lowLiquidityFresh);
      expect(idsBefore).toEqual([lowLiquidityFresh, highLiquidityStale]);

      await updateSortRule("FRESHNESS", { enabled: false });

      const withFreshnessDisabled = await getDiscoveryFeed();
      const idsAfter = withFreshnessDisabled.map((m) => m.id).filter((id) => id === highLiquidityStale || id === lowLiquidityFresh);
      expect(idsAfter).toEqual([highLiquidityStale, lowLiquidityFresh]);
    });

    it("the admin surface lists all three fixed criteria, even a disabled one", async () => {
      await updateSortRule("LIQUIDITY", { enabled: false });
      const all = await listAllSortRules();
      expect(all.map((r) => r.criterion).sort()).toEqual(["CLOSE_TIME", "FRESHNESS", "LIQUIDITY"]);
      expect(all.find((r) => r.criterion === "LIQUIDITY")!.enabled).toBe(false);
    });
  });
});
