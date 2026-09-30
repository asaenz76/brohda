import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryRow } from "@/components/discovery/DiscoveryRow";
import type { CommunityListItem } from "@/lib/communities/discovery";

afterEach(() => cleanup());

vi.mock("@/lib/actions/communities", () => ({
  followCommunityAction: vi.fn(),
  unfollowCommunityAction: vi.fn(),
}));

function makeItem(overrides: Partial<CommunityListItem> = {}): CommunityListItem {
  return {
    id: "c1",
    slug: "chiefs",
    type: "TEAM",
    displayName: "Kansas City Chiefs",
    logoUrl: null,
    isFollowing: false,
    mostRecentPostAt: null,
    ...overrides,
  };
}

// Phase D (Brohda 2.0 redesign) — one Discovery row: identity + follow
// state, nothing else. Locks the "no raw enum" and "no vanity metric"
// restraint rules directly.
describe("DiscoveryRow", () => {
  it("links to the canonical Community destination", () => {
    render(<DiscoveryRow item={makeItem()} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/community/chiefs");
  });

  it("never renders the raw CommunityType enum value", () => {
    const { container } = render(<DiscoveryRow item={makeItem({ type: "LEAGUE", displayName: "NFL" })} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("LEAGUE");
    expect(text).not.toContain("TEAM");
    expect(text).not.toContain("SPORT");
  });

  it("shows a Follow button when not following", () => {
    render(<DiscoveryRow item={makeItem({ isFollowing: false })} />);
    expect(screen.getByRole("button", { name: "Follow" })).toBeInTheDocument();
  });

  it("shows a Following state when already following", () => {
    // CommunityFollowButton's own initiallyFollowing prop seeds its
    // internal state once, not a controlled value — a fresh render (not a
    // rerender of the same instance) is the correct way to assert its
    // initial-following presentation.
    render(<DiscoveryRow item={makeItem({ isFollowing: true })} />);
    expect(screen.getByRole("button", { name: "Following" })).toBeInTheDocument();
  });

  it("renders the display name even when no crest/logo is available", () => {
    render(<DiscoveryRow item={makeItem({ logoUrl: null })} />);
    expect(screen.getByText("Kansas City Chiefs")).toBeInTheDocument();
  });

  it("never renders a follower-count or activity vanity metric", () => {
    const { container } = render(<DiscoveryRow item={makeItem({ mostRecentPostAt: "2026-01-01T00:00:00Z" })} />);
    expect(container.textContent).not.toMatch(/\d+\s*(followers?|posts?)\b/i);
  });
});
