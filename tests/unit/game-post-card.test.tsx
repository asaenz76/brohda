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
    competitionLogoUrl: null,
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

  describe("league crest", () => {
    const crestOf = (item: FeedItem, mode: "member" | "public" = "member") => render(<GamePostCard item={item} mode={mode} />).container.querySelector('[data-slot="league-crest"]');

    it.each([
      ["NFL", "american_football", "/logo-nfl.png"],
      ["NBA", "basketball", "https://media.api-sports.io/basketball/leagues/12.png"],
      ["NHL", "hockey", "https://media.api-sports.io/hockey/leagues/57.png"],
    ])("a %s Game card shows its own league crest and name, in the metadata line (not the hero)", (name, sport, url) => {
      const { container } = render(<GamePostCard item={makeItem({ sport, competitionName: name, competitionLogoUrl: url })} />);
      const header = container.querySelector('[data-slot="league-identity"]')!;
      expect(header.querySelector("img")).toHaveAttribute("src", url);
      expect(header).toHaveTextContent(name);
      // The metadata line, before the matchup link.
      expect(header.closest("p")).toHaveTextContent(name);
      // The visible header is the league alone: "Brohda" only survives as screen-reader authorship text.
      expect(header.closest("p")!.textContent).not.toContain("Brohda ·");
      expect(header.closest("p")!.querySelector(".sr-only")).toHaveTextContent("Game published by Brohda");
    });

    it("the same crest in the member and the public (front door) card — one component, one identity", () => {
      const item = makeItem({ competitionName: "NHL", competitionLogoUrl: "https://media.api-sports.io/hockey/leagues/57.png" });
      expect(crestOf(item, "member")).toHaveAttribute("src", item.competitionLogoUrl!);
      cleanup();
      expect(crestOf(item, "public")).toHaveAttribute("src", item.competitionLogoUrl!);
    });

    it("the crest comes from the Game, not the Market: a Spread or Total primary Market shows the same crest", () => {
      const url = "https://media.api-sports.io/basketball/leagues/12.png";
      const base = makeItem({ sport: "basketball", competitionName: "NBA", competitionLogoUrl: url });
      const total = { ...base, primaryMarket: { ...base.primaryMarket!, marketLabel: "Total 224.5" } };
      expect(crestOf(base)).toHaveAttribute("src", url);
      cleanup();
      expect(crestOf(total)).toHaveAttribute("src", url);
    });

    it("missing crest metadata: the league name as text and no <img> at all", () => {
      const { container } = render(<GamePostCard item={makeItem({ competitionName: "NBA", competitionLogoUrl: null })} />);
      expect(container.querySelector('[data-slot="league-crest"]')).toBeNull();
      expect(container.querySelector('[data-slot="league-identity"]')).toHaveTextContent("NBA");
    });
  });

  describe("sponsorship presentation", () => {
    const sponsorship = { id: "22222222-2222-4222-8222-222222222222", presentedBy: "Acme Sports", tagline: null, ctaText: "Learn more", logoUrl: null, promotion: null };

    it("an item without a sponsorship renders no sponsor line at all", () => {
      const { container } = render(<GamePostCard item={makeItem()} />);
      expect(container.querySelector('[data-slot="sponsored-label"]')).toBeNull();
    });

    it("an item with one shows a single restrained 'Sponsored · Presented by' line, above the matchup, without touching the Pick controls or the sports content", () => {
      const withSponsor = render(<GamePostCard item={makeItem({ sponsorship })} />);
      const label = withSponsor.container.querySelector('[data-slot="sponsored-label"]')!;
      expect(label).toHaveTextContent("Sponsored · Presented by Acme Sports");
      expect(withSponsor.container.querySelectorAll('[data-slot="sponsored-label"]')).toHaveLength(1);
      const sponsoredHtml = withSponsor.container.innerHTML;
      cleanup();
      const plain = render(<GamePostCard item={makeItem()} />).container;
      // Everything outside the label is identical: same matchup, same Pick buttons, same sentiment line, same communities.
      const stripped = sponsoredHtml.replace(/<p[^>]*data-slot="sponsored-label"[\s\S]*?<\/p>/, "");
      expect(stripped).toBe(plain.innerHTML);
    });

    it("renders in public mode too (the front door), where nothing is tracked", () => {
      const { container } = render(<GamePostCard item={makeItem({ sponsorship })} mode="public" />);
      expect(container.querySelector('[data-slot="sponsored-label"]')).not.toBeNull();
    });
  });

  describe("SEE MORE MARKETS", () => {
    const seeMore = (container: HTMLElement) => container.querySelector('[data-slot="see-more-markets"]');

    it("absent for a Game with one eligible Market (count 0 or not supplied)", () => {
      expect(seeMore(render(<GamePostCard item={makeItem()} />).container)).toBeNull();
      cleanup();
      expect(seeMore(render(<GamePostCard item={makeItem({ moreMarketsCount: 0 })} />).container)).toBeNull();
    });

    it.each([1, 2])("visible, on the card itself, when %i more Market(s) exist — and the same canonical Post is the destination", (count) => {
      const { container } = render(<GamePostCard item={makeItem({ moreMarketsCount: count })} />);
      const link = seeMore(container) as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link).toHaveAttribute("href", "/post/post-1");
      expect(link.textContent?.toLowerCase()).toContain("see more markets");
      expect(link.className).toContain("uppercase"); // shown as SEE MORE MARKETS
    });

    it("is its own link (never nested inside another link or button) with a visible focus state and a descriptive accessible name", () => {
      const { container } = render(<GamePostCard item={makeItem({ moreMarketsCount: 1 })} />);
      const link = seeMore(container) as HTMLAnchorElement;
      expect(link.parentElement?.closest("a, button")).toBeNull();
      expect(link.className).toContain("focus-visible:ring");
      expect(link.className).toContain("min-h-9"); // a reasonable tap target
      expect(screen.getByRole("link", { name: /^See more markets for / })).toBe(link);
      expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true"); // the chevron is decoration, not the label
    });

    it("sits below the Pick controls and sentiment, above the communities/comments row, and leaves the Picks untouched", () => {
      const { container } = render(<GamePostCard item={makeItem({ moreMarketsCount: 2 })} />);
      const html = container.innerHTML;
      expect(html.indexOf("prediction-actions")).toBeLessThan(html.indexOf('data-slot="see-more-markets"'));
      expect(html.indexOf('data-slot="see-more-markets"')).toBeLessThan(html.indexOf("0 comments") > -1 ? html.indexOf("comments") : html.length);
      expect(screen.getAllByRole("button", { name: /^Pick / })).toHaveLength(2);
    });

    it("renders in public mode too (the front door)", () => {
      expect(seeMore(render(<GamePostCard item={makeItem({ moreMarketsCount: 1 })} mode="public" />).container)).not.toBeNull();
    });

    it("a sponsored card shows BOTH the sponsor line and the action, in separate places, neither hiding the other", () => {
      const sponsorship = { id: "22222222-2222-4222-8222-222222222222", presentedBy: "Acme Sports", tagline: null, ctaText: "Learn more", logoUrl: null, promotion: null };
      const { container } = render(<GamePostCard item={makeItem({ moreMarketsCount: 2, sponsorship })} />);
      const label = container.querySelector('[data-slot="sponsored-label"]')!;
      const action = seeMore(container)!;
      expect(label).toHaveTextContent("Sponsored · Presented by Acme Sports");
      expect(action).not.toBeNull();
      expect(label.contains(action)).toBe(false);
      expect(action.contains(label)).toBe(false);
      expect(label.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // sponsor line first, action later
      // The sponsor CTA and this action are different links to different places.
      expect(label.querySelector("a")?.getAttribute("href")).toMatch(/^\/sponsorship\/click\//);
      expect((action as HTMLAnchorElement).getAttribute("href")).toBe("/post/post-1");
    });
  });
});
