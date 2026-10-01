import { describe, expect, it } from "vitest";
import { isCommunityTimelineEligible, compareCommunityTimelineItems } from "@/lib/communities/feed";
import type { FeedItem } from "@/lib/communities/feed";

// Phase E (Brohda 2.0 redesign, spec §9-10) — the Community timeline's
// deliberately broader eligibility than Home's isFeedEligible (NOT_STARTED
// only): active/upcoming always eligible, COMPLETED eligible only within
// the admin-configurable retention window, POSTPONED never eligible.
describe("isCommunityTimelineEligible", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("is eligible for a NOT_STARTED game regardless of age", () => {
    expect(isCommunityTimelineEligible({ internalStatus: "NOT_STARTED", updatedAt: "2020-01-01T00:00:00Z" }, now, 24)).toBe(true);
  });

  it.each(["LIVE", "HALFTIME", "EXTRA_TIME", "PENALTIES"])("is eligible for an in-play game (%s) regardless of age", (status) => {
    expect(isCommunityTimelineEligible({ internalStatus: status, updatedAt: "2020-01-01T00:00:00Z" }, now, 24)).toBe(true);
  });

  it("is eligible for a COMPLETED game within the retention window", () => {
    const updatedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(isCommunityTimelineEligible({ internalStatus: "COMPLETED", updatedAt }, now, 24)).toBe(true);
  });

  it("is NOT eligible for a COMPLETED game outside the retention window", () => {
    const updatedAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    expect(isCommunityTimelineEligible({ internalStatus: "COMPLETED", updatedAt }, now, 24)).toBe(false);
  });

  it("is never eligible for a POSTPONED game", () => {
    expect(isCommunityTimelineEligible({ internalStatus: "POSTPONED", updatedAt: now.toISOString() }, now, 24)).toBe(false);
  });

  it("is never eligible when there is no fixture", () => {
    expect(isCommunityTimelineEligible(null, now, 24)).toBe(false);
  });
});

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    post: { id: "post-1", fixtureId: "fixture-1", publishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    homeTeamName: "Home",
    awayTeamName: "Away",
    homeTeamLogoUrl: null,
    awayTeamLogoUrl: null,
    competitionName: null,
    scheduledStartUtc: "2026-06-01T18:00:00Z",
    internalStatus: "NOT_STARTED",
    homeScore: null,
    awayScore: null,
    primaryMarket: null,
    communities: [],
    isFromFollowedCommunity: false,
    commentCount: 0,
    ...overrides,
  };
}

// Phase E (spec §9, documented, no opaque ranking): active/upcoming first,
// then recent completed content, then a deterministic tie-break.
describe("compareCommunityTimelineItems", () => {
  it("puts an active/upcoming game ahead of a completed one", () => {
    const upcoming = makeItem({ post: { ...makeItem().post, id: "a" }, internalStatus: "NOT_STARTED" });
    const completed = makeItem({ post: { ...makeItem().post, id: "b" }, internalStatus: "COMPLETED" });
    expect(compareCommunityTimelineItems(upcoming, completed)).toBeLessThan(0);
    expect(compareCommunityTimelineItems(completed, upcoming)).toBeGreaterThan(0);
  });

  it("among upcoming games, orders soonest-kickoff first", () => {
    const sooner = makeItem({ post: { ...makeItem().post, id: "a" }, internalStatus: "NOT_STARTED", scheduledStartUtc: "2026-06-01T12:00:00Z" });
    const later = makeItem({ post: { ...makeItem().post, id: "b" }, internalStatus: "NOT_STARTED", scheduledStartUtc: "2026-06-02T12:00:00Z" });
    expect(compareCommunityTimelineItems(sooner, later)).toBeLessThan(0);
  });

  it("among completed games, orders most-recent-kickoff first", () => {
    const older = makeItem({ post: { ...makeItem().post, id: "a" }, internalStatus: "COMPLETED", scheduledStartUtc: "2026-05-01T12:00:00Z" });
    const newer = makeItem({ post: { ...makeItem().post, id: "b" }, internalStatus: "COMPLETED", scheduledStartUtc: "2026-05-30T12:00:00Z" });
    expect(compareCommunityTimelineItems(newer, older)).toBeLessThan(0);
  });

  it("falls back to a stable post-id tie-break when times are equal", () => {
    const a = makeItem({ post: { ...makeItem().post, id: "a" }, scheduledStartUtc: "2026-06-01T12:00:00Z" });
    const b = makeItem({ post: { ...makeItem().post, id: "b" }, scheduledStartUtc: "2026-06-01T12:00:00Z" });
    expect(compareCommunityTimelineItems(a, b)).toBeLessThan(0);
  });

  it("produces a fully deterministic sort across a mixed list", () => {
    const items = [
      makeItem({ post: { ...makeItem().post, id: "completed-old" }, internalStatus: "COMPLETED", scheduledStartUtc: "2026-05-01T12:00:00Z" }),
      makeItem({ post: { ...makeItem().post, id: "upcoming-later" }, internalStatus: "NOT_STARTED", scheduledStartUtc: "2026-06-05T12:00:00Z" }),
      makeItem({ post: { ...makeItem().post, id: "completed-new" }, internalStatus: "COMPLETED", scheduledStartUtc: "2026-05-30T12:00:00Z" }),
      makeItem({ post: { ...makeItem().post, id: "upcoming-soon" }, internalStatus: "NOT_STARTED", scheduledStartUtc: "2026-06-01T12:00:00Z" }),
    ];
    items.sort(compareCommunityTimelineItems);
    expect(items.map((i) => i.post.id)).toEqual(["upcoming-soon", "upcoming-later", "completed-new", "completed-old"]);
  });
});
