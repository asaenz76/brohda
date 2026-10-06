import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GamePostCard } from "@/components/posts/GamePostCard";
import type { FeedItem } from "@/lib/communities/feed";
import { choiceFields, nflMoneyline } from "./helpers/choices";

const nflMoneylineFor = (sport: string) => choiceFields({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, homeTeamName: "Home Test NFL", awayTeamName: "Away Test NFL", sport });

afterEach(() => cleanup());

vi.mock("@/lib/actions/predictions", () => ({
  submitPredictionAction: vi.fn(),
}));

function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    post: { id: "post-1", fixtureId: "fixture-1", publishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    sport: "american_football",
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
      ...nflMoneyline("Home Test NFL", "Away Test NFL"),
      yesPercent: null,
      noPercent: null,
      totalPickCount: 0,
      sentimentRevealed: false,
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

  // Pick-first reveal (a locked product rule): Brohda's crowd sentiment is social sentiment, not a betting probability, and appears only once
  // the viewer has made a Pick. Before that — and for anyone logged out — there are no percentages and no count.
  describe("sentiment is revealed by a Pick, never before", () => {
    const picked = (overrides: Record<string, unknown> = {}) =>
      makeItem({ primaryMarket: { ...makeItem().primaryMarket!, yesPercent: 67, noPercent: 33, totalPickCount: 3, sentimentRevealed: true, viewerSelection: "YES", ...overrides } as never });

    it("no Pick: no percentages, no count — only a nudge", () => {
      const { container } = render(<GamePostCard item={makeItem()} />);
      expect(container.textContent).not.toMatch(/\d+%|predicted/);
      expect(screen.getByText("Make your pick to see how everyone else picked.")).toBeInTheDocument();
    });

    it("after a Pick: both visible sides with their percentages, in matchup order, and the predicted count", () => {
      render(<GamePostCard item={picked()} />);
      // The canonical YES 67% / NO 33% relabelled against the visible sides — never "YES 67%".
      expect(screen.getByText("Away Test NFL 33% · Home Test NFL 67% · 3 predicted")).toBeInTheDocument();
      expect(screen.queryByText(/Make your pick to see/)).toBeNull();
    });

    it("after the Pick changes sides: still revealed", () => {
      render(<GamePostCard item={picked({ viewerSelection: "NO" })} />);
      expect(screen.getByText("Away Test NFL 33% · Home Test NFL 67% · 3 predicted")).toBeInTheDocument();
    });

    it("once the Pick is locked (read-only): still revealed", () => {
      render(<GamePostCard item={picked({ isEditable: false, pickDisabledReason: "Picks are locked for this game." })} />);
      expect(screen.getByText("Away Test NFL 33% · Home Test NFL 67% · 3 predicted")).toBeInTheDocument();
    });

    it("once the Game is final and the Pick graded: still revealed", () => {
      render(<GamePostCard item={{ ...picked({ isEditable: false, pickDisabledReason: "Picks are locked for this game." }), internalStatus: "COMPLETED", homeScore: 24, awayScore: 10 }} />);
      expect(screen.getByText("Away Test NFL 33% · Home Test NFL 67% · 3 predicted")).toBeInTheDocument();
    });

    it("logged out: never revealed, even if the data were present", () => {
      const { container } = render(<GamePostCard item={picked()} mode="public" />);
      expect(container.textContent).not.toMatch(/\d+%|predicted/);
    });

    it("no nudge toward picking when picking isn't possible (locked / closed game)", () => {
      const { container } = render(<GamePostCard item={makeItem({ primaryMarket: { ...makeItem().primaryMarket!, isEditable: false, pickDisabledReason: "Picks are locked for this game." } as never })} />);
      expect(container.textContent).not.toMatch(/Make your pick to see/);
    });

    it("no sportsbook or implied-probability copy anywhere on the card", () => {
      const { container } = render(<GamePostCard item={picked()} />);
      expect(container.textContent).not.toMatch(/implied|odds|chance|probabilit|sportsbook|moneyline odds|picked at/i);
    });
  });

  it("renders interactive Pick buttons that are the two teams, in matchup order, never Yes/No or win / do not win", () => {
    const { container } = render(<GamePostCard item={makeItem()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Away Test NFL", "Home Test NFL"]);
    expect(screen.getByRole("button", { name: "Pick Home Test NFL to win" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick Away Test NFL to win" })).toBeInTheDocument();
    const picker = container.querySelector("[data-testid='prediction-actions']")!.textContent!;
    expect(picker).not.toMatch(/\bYes\b|\bNo\b|do not win|\bwin\b/);
  });

  it("a moneyline needs no question line: the team choices already say what is being picked", () => {
    render(<GamePostCard item={makeItem()} />);
    expect(screen.queryByText("Will the Home Test NFL win?")).toBeNull();
    expect(screen.queryByText("Moneyline")).toBeNull();
  });

  it("names a Spread or Total by its compact label and shows its own choices", () => {
    const spread = makeItem({ primaryMarket: { ...makeItem().primaryMarket!, ...choiceFields({ marketTemplate: "SPREAD", yesSide: "HOME", lineValue: 3.5, homeTeamName: "Home Test NFL", awayTeamName: "Away Test NFL", sport: "american_football" }) } });
    const { unmount } = render(<GamePostCard item={spread} />);
    expect(screen.getByText("Spread")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Away Test NFL -3.5", "Home Test NFL +3.5"]);
    unmount();
    const total = makeItem({ primaryMarket: { ...makeItem().primaryMarket!, ...choiceFields({ marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5 }) } });
    render(<GamePostCard item={total} />);
    expect(screen.getByText("Total 47.5")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Over 47.5", "Under 47.5"]);
  });

  it("falls back to the original question and generic labels for a Market it can't describe — no crash, no guess", () => {
    const legacy = makeItem({ primaryMarket: { ...makeItem().primaryMarket!, question: "Some older question?", ...choiceFields({}) } });
    render(<GamePostCard item={legacy} />);
    expect(screen.getByText("Some older question?")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Yes", "No"]);
  });

  it("shows a read-only locked state instead of interactive buttons once the viewer's Pick is locked", () => {
    render(
      <GamePostCard
        item={makeItem({
          primaryMarket: {
            id: "market-1",
            question: "Will the Home Test NFL win?",
            ...nflMoneyline("Home Test NFL", "Away Test NFL"),
            yesPercent: 100,
            noPercent: 0,
            totalPickCount: 1,
            sentimentRevealed: true,
            status: "ACTIVE",
            viewerSelection: "YES",
            isEditable: false,
            pickDisabledReason: "Picks are locked for this game.",
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Pick:/ })).toBeNull();
    expect(screen.getByText("You picked Home Test NFL — Picks are locked for this game.")).toBeInTheDocument();
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

  it("links the matchup header to the canonical Post, never to /markets/[id]", () => {
    render(<GamePostCard item={makeItem()} />);
    const headerLink = screen.getByText(/Away Test NFL @/).closest("a");
    expect(headerLink).toHaveAttribute("href", "/post/post-1");
  });

  describe("the matchup follows the sport, not a hard-coded order", () => {
    it("American football reads Away @ Home — header, accessible name and final score", () => {
      const { container } = render(<GamePostCard item={makeItem({ sport: "american_football", internalStatus: "COMPLETED", homeScore: 24, awayScore: 10 })} />);
      expect(screen.getByText(/Away Test NFL @/)).toBeInTheDocument();
      expect(screen.getByRole("article", { name: "Game: Away Test NFL at Home Test NFL" })).toBeInTheDocument();
      expect(container.textContent).toContain("Final 10-24"); // away score first, as the teams read
    });

    it("football (soccer) reads Home vs Away — the same card, the other order", () => {
      const { container } = render(<GamePostCard item={makeItem({ sport: "football", internalStatus: "COMPLETED", homeScore: 24, awayScore: 10 })} />);
      expect(screen.getByText(/Home Test NFL vs/)).toBeInTheDocument();
      expect(screen.getByRole("article", { name: "Game: Home Test NFL vs Away Test NFL" })).toBeInTheDocument();
      expect(container.textContent).toContain("Final 24-10");
      expect(container.textContent).not.toMatch(/Away Test NFL @/);
    });

    it("the Pick choices follow the same order as the header", () => {
      const football = { ...makeItem({ sport: "football" }) };
      football.primaryMarket = { ...football.primaryMarket!, ...nflMoneylineFor("football") };
      render(<GamePostCard item={football} />);
      expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Home Test NFL", "Away Test NFL"]);
    });
  });
});
