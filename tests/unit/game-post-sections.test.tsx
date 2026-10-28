import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { GameMarketSentimentSection } from "@/components/posts/GameMarketSentiment";
import { GamePreviewSection } from "@/components/posts/GamePreviewSection";
import type { GameMarketSentiment } from "@/lib/posts/game-sentiment";

afterEach(() => cleanup());

const moneyline: GameMarketSentiment = {
  marketId: "m1",
  label: "Moneyline",
  choices: [
    { outcome: "NO", label: "New Jersey Devils", percent: 33 },
    { outcome: "YES", label: "Washington Capitals", percent: 67 },
  ],
  revealed: true,
  hasViewerPick: true,
  totalPickCount: 3,
  viewerChoiceLabel: "Washington Capitals",
  viewerConfidence: 5,
  viewerResult: null,
};
const total: GameMarketSentiment = { ...moneyline, marketId: "m2", label: "Total 6", choices: [{ outcome: "YES", label: "Over 6", percent: 40 }, { outcome: "NO", label: "Under 6", percent: 60 }], totalPickCount: 5, viewerChoiceLabel: null, viewerConfidence: null, viewerResult: null, revealed: true };
const spreadHidden: GameMarketSentiment = { ...moneyline, marketId: "m3", label: "Spread", choices: [{ outcome: "YES", label: "Washington Capitals +1.5", percent: null }, { outcome: "NO", label: "New Jersey Devils -1.5", percent: null }], revealed: false, hasViewerPick: false, totalPickCount: 0, viewerChoiceLabel: null, viewerConfidence: null, viewerResult: null };

describe("Market sentiment on the Post", () => {
  it("shows each revealed Market as a labelled block with both sides' shares and the predicted count", () => {
    render(<GameMarketSentimentSection markets={[moneyline, total]} />);
    const blocks = screen.getAllByText(/predicted$/).map((p) => p.closest('[data-slot="market-sentiment-block"]')!);
    expect(blocks).toHaveLength(2);
    expect(within(blocks[0] as HTMLElement).getByRole("heading", { name: "Moneyline" })).toBeInTheDocument();
    expect(blocks[0]).toHaveTextContent("33%");
    expect(blocks[0]).toHaveTextContent("67%");
    expect(blocks[0]).toHaveTextContent("New Jersey Devils");
    expect(blocks[0]).toHaveTextContent("3 predicted");
    expect(within(blocks[1] as HTMLElement).getByRole("heading", { name: "Total 6" })).toBeInTheDocument();
    expect(blocks[1]).toHaveTextContent("40%");
    expect(blocks[1]).toHaveTextContent("Under 6");
    expect(blocks[1]).toHaveTextContent("5 predicted");
  });

  it("is compact: the two sides sit side by side in even columns at a small size, and the predicted count shares the Market's title line", () => {
    const { container } = render(<GameMarketSentimentSection markets={[moneyline]} />);
    const grid = container.querySelector('[data-slot="sentiment-shares"]')!;
    expect(grid.className).toContain("grid-cols-2");
    expect(grid.children).toHaveLength(2);
    const sizes = [...grid.querySelectorAll("span")].map((e) => e.className);
    expect(sizes.join(" ")).not.toMatch(/text-(2xl|3xl|4xl)/); // no headline-sized numbers
    // A long team name never breaks mid-word on a phone: smaller label type, and below 360px the label sits under the number.
    expect(grid.firstElementChild!.className).toContain("max-[359px]:flex-col");
    expect(grid.querySelector("span:last-child")!.className).toContain("text-[11px]");
    const header = screen.getByRole("heading", { name: "Moneyline" }).parentElement!;
    expect(header).toHaveTextContent("3 predicted"); // title and count on one line
  });

  it("withholds a Market the viewer has not predicted on: no percentages, no count, just where the numbers come from", () => {
    render(<GameMarketSentimentSection markets={[spreadHidden]} />);
    const block = screen.getByRole("heading", { name: "Spread" }).closest('[data-slot="market-sentiment-block"]')!;
    expect(block).toHaveTextContent("Make your pick to see how everyone else picked.");
    expect(block.textContent).not.toMatch(/%|predicted/);
  });

  it("never fabricates 0% / 0%: a revealed Market nobody has picked says so", () => {
    render(<GameMarketSentimentSection markets={[{ ...moneyline, totalPickCount: 0, choices: moneyline.choices.map((c) => ({ ...c, percent: null })) }]} />);
    expect(screen.getByText("No one has predicted yet.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/0%/);
  });

  it("shows the viewer's own prediction as context — side and Confidence — not as a prediction card", () => {
    render(<GameMarketSentimentSection markets={[moneyline]} />);
    expect(screen.getByText(/Your prediction:/).closest("p")).toHaveTextContent("Your prediction: Washington Capitals · 🔥5");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Confidence · Locked|How confident|You picked/)).toBeNull();
  });

  it("reads the viewer's graded result in plain words next to their prediction", () => {
    render(<GameMarketSentimentSection markets={[{ ...moneyline, viewerResult: "CORRECT" }]} />);
    expect(screen.getByText(/Your prediction:/).closest("p")).toHaveTextContent("Result: Correct");
    cleanup();
    render(<GameMarketSentimentSection markets={[{ ...moneyline, viewerResult: "INCORRECT" }]} />);
    expect(screen.getByText(/Your prediction:/).closest("p")).toHaveTextContent("Result: Incorrect");
    cleanup();
    render(<GameMarketSentimentSection markets={[{ ...moneyline, viewerResult: "VOID" }]} />);
    expect(screen.getByText(/Your prediction:/).closest("p")).toHaveTextContent("Result: Void");
  });

  it("has no Pick buttons, no Confidence control and no 'more markets' links at all", () => {
    const { container } = render(<GameMarketSentimentSection markets={[moneyline, total, spreadHidden]} />);
    expect(container.querySelectorAll("button, a, input")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/more markets/i);
  });

  it("renders nothing for a Game with no Markets", () => {
    const { container } = render(<GameMarketSentimentSection markets={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the Game Preview block", () => {
  const espn = { url: "https://www.espn.com/nfl/story/_/id/1/chiefs-pass-rush", name: "ESPN", title: "Chiefs pass rush searching for answers", publishedAt: "2026-10-15T10:00:00.000Z" };
  const preview = { fixtureId: "f1", hook: "Seven goals. Your move, Washington.", body: "The Devils crushed the Rangers 7-1. Today, they chase a third straight win against the Capitals. Who takes it?", generatedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), frozenAt: null, sources: [espn] };

  it("shows the hook and the story under a 'Game Preview' heading", () => {
    render(<GamePreviewSection preview={preview} />);
    expect(screen.getByRole("heading", { name: "Game Preview" })).toBeInTheDocument();
    expect(screen.getByText("Seven goals. Your move, Washington.")).toBeInTheDocument();
    expect(screen.getByText(/crushed the Rangers 7-1/)).toBeInTheDocument();
  });

  it("is simply absent when there is no saved Preview — no placeholder, no error", () => {
    const { container } = render(<GamePreviewSection preview={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("credits the primary source in small print under the text: 'Source: ESPN · Oct 15, 2026', linking to the publisher's own page", () => {
    const { container } = render(<GamePreviewSection preview={preview} />);
    const footer = container.querySelector('[data-slot="game-preview-source"]')!;
    expect(footer.textContent).toBe("Source: ESPN · Oct 15, 2026");
    const link = footer.querySelector("a")!;
    expect(link).toHaveAttribute("href", espn.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link).toHaveAttribute("title", "Chiefs pass rush searching for answers");
    // accessible name carries the publisher and the article, and says it opens a new tab
    expect(screen.getByRole("link", { name: "Source: ESPN — Chiefs pass rush searching for answers (opens in a new tab)" })).toBe(link);
    // visually secondary: small, muted, and below the story (after the body in the document)
    expect(footer.className).toMatch(/text-xs/);
    expect(footer.className).toMatch(/text-text-muted/);
    expect(container.querySelector('[data-slot="game-preview-body"]')!.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the story itself is untouched by the credit
    expect(container.querySelector('[data-slot="game-preview-body"]')!.textContent).toBe(preview.body);
  });

  it("a second source appears only when the Preview carries one, as 'Also:' — never a bibliography", () => {
    const nfl = { url: "https://www.nfl.com/news/x", name: "NFL.com", title: null, publishedAt: null };
    const { container } = render(<GamePreviewSection preview={{ ...preview, sources: [espn, nfl] }} />);
    const footer = container.querySelector('[data-slot="game-preview-source"]')!;
    expect(footer.textContent).toBe("Source: ESPN · Oct 15, 2026 · Also: NFL.com");
    expect(footer.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Also: NFL.com (opens in a new tab)" })).toHaveAttribute("href", nfl.url);
  });

  it("omits the date when the source has none, and shows the name when there is no article title", () => {
    const { container } = render(<GamePreviewSection preview={{ ...preview, sources: [{ ...espn, title: null, publishedAt: null }] }} />);
    expect(container.querySelector('[data-slot="game-preview-source"]')!.textContent).toBe("Source: ESPN");
    expect(screen.getByRole("link", { name: "Source: ESPN (opens in a new tab)" })).toBeInTheDocument();
  });

  it("no visible supporting source, no Preview: a Preview with nothing to credit is not shown", () => {
    const { container } = render(<GamePreviewSection preview={{ ...preview, sources: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
