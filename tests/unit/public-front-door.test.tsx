import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The member Pick control calls a server action; this file only needs it importable.
vi.mock("@/lib/actions/predictions", () => ({ submitPickAction: vi.fn(), setPickAction: vi.fn() }));
// The tab bar is Discovery's own client component, which navigates with the router.
const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

import { PublicFrontDoor } from "@/components/landing/PublicFrontDoor";
import { GamePostCard } from "@/components/posts/GamePostCard";
import type { FeedItem } from "@/lib/communities/feed";
import type { CommunityListItem } from "@/lib/communities/discovery";

afterEach(() => cleanup());

function item(overrides: Partial<FeedItem> = {}, id = "post-1"): FeedItem {
  return {
    post: { id, fixtureId: "fx-1", publishedAt: "2026-10-01T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" },
    homeTeamName: "Buffalo Bills",
    awayTeamName: "New England Patriots",
    homeTeamLogoUrl: null,
    awayTeamLogoUrl: null,
    competitionName: "NFL",
    scheduledStartUtc: "2030-10-04T15:00:00Z",
    internalStatus: "NOT_STARTED",
    homeScore: null,
    awayScore: null,
    primaryMarket: {
      id: "m-1",
      question: "Will the Buffalo Bills win?",
      yesLabel: "Buffalo Bills win",
      noLabel: "Buffalo Bills do not win",
      yesPercent: 67,
      noPercent: 33,
      totalPickCount: 42,
      viewerSelection: null,
      isEditable: true,
      pickDisabledReason: null,
    } as FeedItem["primaryMarket"],
    communities: [{ id: "c-1", slug: "nfl", displayName: "NFL", type: "LEAGUE" } as FeedItem["communities"][number]],
    isFromFollowedCommunity: false,
    commentCount: 8,
    ...overrides,
  };
}

const text = (container: HTMLElement) => container.textContent ?? "";

function community(overrides: Partial<CommunityListItem> = {}): CommunityListItem {
  return { id: "c-1", slug: "nfl", type: "LEAGUE", displayName: "NFL", logoUrl: null, isFollowing: false, mostRecentPostAt: null, ...overrides };
}

type Props = Partial<React.ComponentProps<typeof PublicFrontDoor>>;
function renderDoor(props: Props = {}) {
  return render(<PublicFrontDoor tab="sports" feed={[]} communities={[]} {...props} />);
}

describe("PublicFrontDoor", () => {
  it("is the logged-out social network: Game Posts in the centre, two ways in, brand line", () => {
    const { container } = renderDoor({ feed: [item({}, "post-1"), item({ homeTeamName: "Boston Celtics", awayTeamName: "New York Knicks" }, "post-2")] });

    expect(screen.getAllByRole("heading", { level: 1, name: "Sports opinions should have a record." }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pick a side. Talk shit. Call BS. See who was right.").length).toBeGreaterThan(0);
    for (const link of screen.getAllByRole("link", { name: "Create account" })) expect(link).toHaveAttribute("href", "/register");
    for (const link of screen.getAllByRole("link", { name: "Log in" })) expect(link).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(container.querySelector("main")).not.toBeNull();
  });

  it("links every Game to its real Post, and its comment count to the same Post", () => {
    renderDoor({ feed: [item({}, "post-9")] });
    const article = screen.getByRole("article", { name: "Game: New England Patriots at Buffalo Bills" });
    const hrefs = within(article).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h === "/post/post-9").length).toBe(2); // the matchup block and the comments link
  });

  it("states that the Game is published by Brohda, never by a person", () => {
    const { container } = renderDoor({ feed: [item()] });
    const article = screen.getByRole("article");
    expect(text(article)).toContain("Game published by");
    expect(text(article)).toContain("Brohda");
    expect(text(article)).toContain("NFL");
    // No author, no "posted by", no avatar, no per-user timestamp anywhere in a Game Post.
    expect(text(container)).not.toMatch(/posted by|authored by|created by/i);
    expect(within(article).queryAllByRole("img")).toHaveLength(0);
  });

  it("shows only aggregate public data: sentiment and a comment COUNT — never a person, a comment or a Pick", () => {
    const { container } = renderDoor({ feed: [item()] });
    expect(text(container)).toContain("Buffalo Bills win 67% · Buffalo Bills do not win 33% · 42 predicted");
    expect(text(container)).toContain("8 comments");
    expect(text(container)).not.toMatch(/prediction accuracy|you picked/i);
  });

  it("has no composer of any kind — a visitor cannot create or publish a Game or a post", () => {
    const { container } = renderDoor({ feed: [item()] });
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(0);
    // Composer phrasing only: "Game published by Brohda" is the platform-authorship cue and must stay.
    expect(text(container)).not.toMatch(/what['’]s on your mind|create post|new post|\bcompose\b|create prediction|publish event|post event|new game|\bpublish\b/i);
  });

  it("keeps money, the old pool product and promotional language out of every word it renders", () => {
    const { container } = renderDoor({ feed: [item(), item({ commentCount: 0 }, "post-2")] });
    const all = text(container);
    const forbidden = /\b(pools?|leaderboards?|analytics|winnings|stakes?|wallet|payout|put money on it|bet|bets|betting|wager|usdt|real money|no money)\b/i;
    expect(all).not.toMatch(forbidden);
  });

  it("renders no logged-in controls: Picks are links, never mutation buttons, and there are no money controls", () => {
    renderDoor({ feed: [item()] });
    // The only button on the page is the menu trigger; tabs are role=tab, Picks are links.
    expect(screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open menu"]);
    const picks = screen.getAllByRole("link", { name: /^Pick: / });
    expect(picks).toHaveLength(2);
    for (const pick of picks) expect(pick).toHaveAttribute("href", "/register");
  });

  it("explains an unavailable Pick instead of offering one", () => {
    const market = { ...item().primaryMarket!, pickDisabledReason: "Picks are locked for this game." };
    renderDoor({ feed: [item({ primaryMarket: market })] });
    expect(screen.getAllByText("Picks are locked for this game.").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("link", { name: /^Pick: / })).toHaveLength(0);
  });

  it("shows restrained empty copy — not marketing filler — when no Games are on the board", () => {
    const { container } = renderDoor({ feed: [] });
    expect(text(container)).toContain("No games are on the board right now.");
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("puts Upcoming games over exactly Sports | Leagues | Teams, Sports selected by default, in the centre column", () => {
    renderDoor({ feed: [item()] });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 2, name: "Upcoming games" })).toBeInTheDocument();
    const tabs = within(main).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Sports", "Leagues", "Teams"]);
    expect(within(main).getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
  });

  it("reuses Discovery's tab bar against the front door's own URL", () => {
    renderDoor({ feed: [item()] });
    fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
    expect(push).toHaveBeenCalledWith("/?tab=teams");
    expect(refresh).toHaveBeenCalled();
  });

  it("Leagues and Teams show the real Community lists, read-only, and no Game Posts", () => {
    const { container } = renderDoor({
      tab: "teams",
      communities: [community({ id: "t1", slug: "buffalo-bills", type: "TEAM", displayName: "Buffalo Bills" }), community({ id: "t2", slug: "boston-celtics", type: "TEAM", displayName: "Boston Celtics" })],
    });
    expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("link", { name: "Buffalo Bills" })).toHaveAttribute("href", "/community/buffalo-bills");
    expect(screen.getByRole("link", { name: "Boston Celtics" })).toHaveAttribute("href", "/community/boston-celtics");
    // Following is an account action: no follow control, no Game Posts on a Community tab.
    expect(screen.queryByRole("button", { name: /follow/i })).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(text(container)).not.toContain("No games are on the board");
  });

  it("shows Discovery's own empty copy for an empty Leagues tab", () => {
    renderDoor({ tab: "leagues", communities: [] });
    expect(screen.getByText("No leagues to show yet.")).toBeInTheDocument();
  });

  it("keeps Sports / Leagues / Teams out of the left sidebar — the centre tabs are the way to browse", () => {
    renderDoor({ feed: [item()] });
    const left = screen.getByRole("complementary", { name: "About Brohda" });
    for (const label of ["Sports", "Leagues", "Teams"]) expect(within(left).queryByRole("link", { name: label })).toBeNull();
    // What it does keep: search (honestly account-gated), one line about Brohda, legal.
    expect(within(left).getByRole("link", { name: /Search/ })).toHaveAttribute("href", "/login");
    expect(within(left).getByText("Brohda is a social network for people who think they know sports.")).toBeInTheDocument();
    expect(within(left).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(within(left).getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  });

  it("exposes named landmarks so structure doesn't depend on layout", () => {
    renderDoor({ feed: [item()] });
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getAllByRole("complementary").map((el) => el.getAttribute("aria-label")).sort()).toEqual(["About Brohda", "Join Brohda"]);
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
  });
});

describe("PublicFrontDoor — mobile bottom bar and menu", () => {
  it("has a bottom bar with both account actions and a labelled hamburger, with safe-area padding", () => {
    renderDoor({ feed: [item()] });
    const bar = screen.getByTestId("public-bottom-bar");
    expect(within(bar).getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(within(bar).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    const burger = within(bar).getByRole("button", { name: "Open menu" });
    expect(burger).toHaveAttribute("aria-expanded", "false");
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
    // The account actions come first and the hamburger last, so it sits at the bottom right.
    const order = Array.from(bar.querySelectorAll("a, button")).map((el) => el.textContent || el.getAttribute("aria-label"));
    expect(order).toEqual(["Create account", "Log in", "Open menu"]);
  });

  it("opens a compact menu: Search, the three tab shortcuts, About Brohda, Terms, Privacy — and nothing that creates content or moves money", async () => {
    renderDoor({ feed: [item()] });
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = await screen.findByTestId("public-mobile-menu");
    expect(screen.getByRole("dialog")).toBe(menu);
    const links = within(menu).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["SearchLog in to search", "/login"],
      ["Sports", "/?tab=sports"],
      ["Leagues", "/?tab=leagues"],
      ["Teams", "/?tab=teams"],
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
    ]);
    expect(within(menu).getByRole("heading", { name: "About Brohda" })).toBeInTheDocument();
    expect(text(menu)).toContain("Brohda is a social network for people who think they know sports.");
    expect(text(menu)).not.toMatch(/create (post|game|prediction)|new (post|game)|\bpublish\b|\b(bet|wager|stake|wallet|payout)\b/i);
  });

  it("closes with Escape and with the close button, and returns focus to the hamburger", async () => {
    renderDoor({ feed: [item()] });
    const burger = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(burger);
    await screen.findByTestId("public-mobile-menu");
    fireEvent.keyDown(screen.getByTestId("public-mobile-menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("public-mobile-menu")).toBeNull());
    await waitFor(() => expect(burger).toHaveFocus());

    fireEvent.click(burger);
    await screen.findByTestId("public-mobile-menu");
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(screen.queryByTestId("public-mobile-menu")).toBeNull());
  });

  it("closes when a menu link is followed", async () => {
    renderDoor({ feed: [item()] });
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = await screen.findByTestId("public-mobile-menu");
    fireEvent.click(within(menu).getByRole("link", { name: "Leagues" }));
    await waitFor(() => expect(screen.queryByTestId("public-mobile-menu")).toBeNull());
  });
});

describe("GamePostCard modes", () => {
  it("public mode: Community chips are plain text, the Pick control is links, there is no 'Following' badge", () => {
    render(<GamePostCard item={item({ isFromFollowedCommunity: true })} mode="public" />);
    expect(screen.queryByRole("link", { name: /^NFL/ })).toBeNull();
    expect(screen.queryByText("Following")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("member mode is unchanged: real Pick buttons, linked Community chips, no Brohda eyebrow, no article wrapper", () => {
    const { container } = render(<GamePostCard item={item()} />);
    expect(screen.getAllByRole("button", { name: /^Pick: / })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /^NFL/ })).toHaveAttribute("href", "/community/nfl");
    expect(text(container)).not.toContain("Game published by");
    expect(screen.queryByRole("article")).toBeNull();
  });
});
