import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GamePostCard } from "@/components/posts/GamePostCard";
import type { FeedItem } from "@/lib/communities/feed";

afterEach(() => cleanup());

vi.mock("@/lib/actions/predictions", () => ({
  submitPredictionAction: vi.fn(),
}));

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    post: { id: "post-1", fixtureId: "fixture-1", publishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    homeTeamName: "Home Test NFL",
    awayTeamName: "Away Test NFL",
    homeTeamLogoUrl: null,
    awayTeamLogoUrl: null,
    competitionName: "Test League",
    scheduledStartUtc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    internalStatus: "NOT_STARTED",
    homeScore: null,
    awayScore: null,
    primaryMarket: {
      id: "market-1",
      question: "Will the Home Test NFL win?",
      yesLabel: "Home Test NFL win",
      noLabel: "Home Test NFL do not win",
      yesPercent: 67,
      noPercent: 33,
      totalPickCount: 3,
      status: "ACTIVE",
      viewerSelection: null,
      isEditable: true,
      pickDisabledReason: null,
    },
    communities: [
      { id: "c1", slug: "home-test-nfl", type: "TEAM", displayName: "Home Test NFL" },
      { id: "c2", slug: "away-test-nfl", type: "TEAM", displayName: "Away Test NFL" },
      { id: "c3", slug: "nfl", type: "LEAGUE", displayName: "NFL" },
    ],
    isFromFollowedCommunity: false,
    commentCount: 5,
    ...overrides,
  };
}

// Phase C (Brohda 2.0 redesign) — the Home timeline's Game Post. Locks
// the "no Pool content on Home" test the milestone itself proposes
// (spec §1: "no reason to know Brohda once had a Pools product"),
// alongside sentiment-labeling correctness and community-badge restraint.
describe("GamePostCard", () => {
  it("never renders Pool-era words anywhere in its output", () => {
    const { container } = render(<GamePostCard item={makeItem()} />);
    const text = container.textContent?.toLowerCase() ?? "";
    for (const word of ["pool", "pools", "entry", "entries", "wager", "bet", "stake"]) {
      expect(text).not.toContain(word);
    }
  });

  it("shows real sentiment with both semantic labels and the predicted count, never a raw provider price", () => {
    render(<GamePostCard item={makeItem()} />);
    expect(screen.getByText("Home Test NFL win 67% · Home Test NFL do not win 33% · 3 predicted")).toBeInTheDocument();
  });

  it("shows an honest empty-sentiment state when nobody has predicted yet", () => {
    render(
      <GamePostCard
        item={makeItem({
          primaryMarket: {
            id: "market-1",
            question: "Will the Home Test NFL win?",
            yesLabel: "Home Test NFL win",
            noLabel: "Home Test NFL do not win",
            yesPercent: null,
            noPercent: null,
            totalPickCount: 0,
            status: "ACTIVE",
            viewerSelection: null,
            isEditable: true,
            pickDisabledReason: null,
          },
        })}
      />,
    );
    expect(screen.getByText("No one has predicted yet.")).toBeInTheDocument();
  });

  it("renders interactive Pick buttons with semantic labels, never raw YES/NO", () => {
    render(<GamePostCard item={makeItem()} />);
    expect(screen.getByRole("button", { name: "Pick: Home Test NFL win" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick: Home Test NFL do not win" })).toBeInTheDocument();
  });

  it("shows a read-only locked state instead of interactive buttons once the viewer's Pick is locked", () => {
    render(
      <GamePostCard
        item={makeItem({
          primaryMarket: {
            id: "market-1",
            question: "Will the Home Test NFL win?",
            yesLabel: "Home Test NFL win",
            noLabel: "Home Test NFL do not win",
            yesPercent: 100,
            noPercent: 0,
            totalPickCount: 1,
            status: "ACTIVE",
            viewerSelection: "YES",
            isEditable: false,
            pickDisabledReason: "Picks are locked for this game.",
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Pick:/ })).toBeNull();
    expect(screen.getByText("You picked Home Test NFL win — Picks are locked for this game.")).toBeInTheDocument();
  });

  it("caps visible Community badges and shows a remainder count instead of a wall of badges", () => {
    render(<GamePostCard item={makeItem()} />);
    expect(screen.getByText("Home Test NFL", { selector: "a" })).toBeInTheDocument();
    expect(screen.getByText("Away Test NFL", { selector: "a" })).toBeInTheDocument();
    expect(screen.queryByText("NFL", { selector: "a" })).toBeNull();
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("shows the real comment count, linking to the canonical Post", () => {
    render(<GamePostCard item={makeItem({ commentCount: 5 })} />);
    const commentLink = screen.getByText("5 comments").closest("a");
    expect(commentLink).toHaveAttribute("href", "/post/post-1");
  });

  it("links the team/question header to the canonical Post, never to /markets/[id]", () => {
    render(<GamePostCard item={makeItem()} />);
    const headerLink = screen.getByText("Will the Home Test NFL win?").closest("a");
    expect(headerLink).toHaveAttribute("href", "/post/post-1");
  });
});
