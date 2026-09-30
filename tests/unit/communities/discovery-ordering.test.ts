import { describe, expect, it } from "vitest";
import { compareCommunityListItems } from "@/lib/communities/discovery";
import type { CommunityListItem } from "@/lib/communities/discovery";

// Phase D (Brohda 2.0 redesign, spec §11) — the documented, non-opaque
// Discovery ordering rule: followed first, then most recent relevant
// activity (most recent distributed Post), then alphabetical as the
// deterministic fallback. No popularity score, no engagement bait.
function item(overrides: Partial<CommunityListItem>): CommunityListItem {
  return {
    id: "c1",
    slug: "c1",
    type: "TEAM",
    displayName: "Team",
    logoUrl: null,
    isFollowing: false,
    mostRecentPostAt: null,
    ...overrides,
  };
}

describe("compareCommunityListItems", () => {
  it("puts a followed Community ahead of an unfollowed one, regardless of activity", () => {
    const followed = item({ isFollowing: true, mostRecentPostAt: null });
    const unfollowed = item({ isFollowing: false, mostRecentPostAt: "2026-01-01T00:00:00Z" });
    expect(compareCommunityListItems(followed, unfollowed)).toBeLessThan(0);
    expect(compareCommunityListItems(unfollowed, followed)).toBeGreaterThan(0);
  });

  it("among equally-followed items, orders by most recent activity first", () => {
    const recent = item({ mostRecentPostAt: "2026-02-01T00:00:00Z" });
    const older = item({ mostRecentPostAt: "2026-01-01T00:00:00Z" });
    expect(compareCommunityListItems(recent, older)).toBeLessThan(0);
  });

  it("an item with no activity ever sorts after one with any activity", () => {
    const withActivity = item({ mostRecentPostAt: "2026-01-01T00:00:00Z" });
    const noActivity = item({ mostRecentPostAt: null });
    expect(compareCommunityListItems(withActivity, noActivity)).toBeLessThan(0);
    expect(compareCommunityListItems(noActivity, withActivity)).toBeGreaterThan(0);
  });

  it("falls back to alphabetical display name when follow state and activity both tie", () => {
    const a = item({ displayName: "Alpha", mostRecentPostAt: "2026-01-01T00:00:00Z" });
    const b = item({ displayName: "Bravo", mostRecentPostAt: "2026-01-01T00:00:00Z" });
    expect(compareCommunityListItems(a, b)).toBeLessThan(0);
    expect(compareCommunityListItems(b, a)).toBeGreaterThan(0);
  });

  it("two items with no activity at all fall back to alphabetical order", () => {
    const a = item({ displayName: "Alpha", mostRecentPostAt: null });
    const b = item({ displayName: "Bravo", mostRecentPostAt: null });
    expect(compareCommunityListItems(a, b)).toBeLessThan(0);
  });

  it("produces a fully deterministic sort across a mixed list", () => {
    const items = [
      item({ id: "1", displayName: "Zulu", isFollowing: false, mostRecentPostAt: null }),
      item({ id: "2", displayName: "Alpha", isFollowing: true, mostRecentPostAt: "2026-01-01T00:00:00Z" }),
      item({ id: "3", displayName: "Bravo", isFollowing: true, mostRecentPostAt: "2026-02-01T00:00:00Z" }),
      item({ id: "4", displayName: "Charlie", isFollowing: false, mostRecentPostAt: "2026-01-15T00:00:00Z" }),
    ];
    items.sort(compareCommunityListItems);
    expect(items.map((i) => i.id)).toEqual(["3", "2", "4", "1"]);
  });
});
