import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PredictionActions } from "@/components/predictions/PredictionActions";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { submitPredictionAction } from "@/lib/actions/predictions";

afterEach(() => cleanup());
beforeEach(() => vi.mocked(submitPredictionAction).mockReset());

vi.mock("@/lib/actions/predictions", () => ({
  submitPredictionAction: vi.fn(),
}));

const teams = { homeTeamName: "Indianapolis Colts", awayTeamName: "Washington Commanders", sport: "american_football" };
const moneyline = getChoicePresentation({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, ...teams }).choices;
const spread = getChoicePresentation({ marketTemplate: "SPREAD", yesSide: "HOME", lineValue: 3.5, ...teams }).choices;
const total = getChoicePresentation({ marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5, ...teams }).choices;

// Phase C (Brohda 2.0 redesign, spec §39) — regression guard for the
// mobile Pick-button overflow bug: two buttons with long labels overflowed a
// 375px card rather than wrapping. Fixed by stacking full-width below `sm`
// and reverting to an inline auto-width row at `sm`+ — this checks the
// classes that fix actually landed, not layout pixels (jsdom has no layout).
describe("PredictionActions mobile overflow fix", () => {
  it("stacks full-width below sm and reverts to auto width at sm+, and lets a long team name wrap", () => {
    render(<PredictionActions marketId="m1" disabledReason={null} choices={moneyline} />);
    for (const name of ["Pick Washington Commanders to win", "Pick Indianapolis Colts to win"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass("w-full", "sm:w-auto", "whitespace-normal");
    }
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" }).parentElement).toHaveClass("flex-col", "sm:flex-row", "sm:flex-wrap");
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveClass("sm:max-w-full");
  });
});

describe("PredictionActions — what is shown versus what is stored", () => {
  it("shows the two teams in matchup order with unambiguous names, never Yes / No / win / do not win", () => {
    const { container } = render(<PredictionActions marketId="m1" disabledReason={null} choices={moneyline} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Washington Commanders", "Indianapolis Colts"]); // Away @ Home, though YES is the home team
    expect(container.textContent).not.toMatch(/\bYes\b|\bNo\b|do not win/);
  });

  it("selected state follows the canonical outcome, not the label or the position", () => {
    // Stored YES = the home team = the SECOND button in matchup order.
    render(<PredictionActions marketId="m1" disabledReason={null} currentSelection="YES" choices={moneyline} />);
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["moneyline", moneyline, "Pick Washington Commanders to win", "NO"],
    ["moneyline (home)", moneyline, "Pick Indianapolis Colts to win", "YES"],
    ["spread (underdog)", spread, "Pick Indianapolis Colts plus 3.5", "YES"],
    ["spread (favourite)", spread, "Pick Washington Commanders minus 3.5", "NO"],
    ["total (over)", total, "Pick Over 47.5 total points", "YES"],
    ["total (under)", total, "Pick Under 47.5 total points", "NO"],
  ] as const)("%s: tapping '%s' submits the canonical %s", async (_n, choices, name, outcome) => {
    vi.mocked(submitPredictionAction).mockResolvedValue({ success: true, confirmation: { selectedOutcome: outcome } } as never);
    render(<PredictionActions marketId="m1" disabledReason={null} choices={choices} />);
    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(submitPredictionAction).toHaveBeenCalledWith(expect.objectContaining({ marketId: "m1", selectedOutcome: outcome })));
  });

  it("changing the Pick moves the selected state to the other visible choice and confirms in the visible words", async () => {
    vi.mocked(submitPredictionAction).mockResolvedValue({ success: true, confirmation: { selectedOutcome: "NO" } } as never);
    render(<PredictionActions marketId="m1" disabledReason={null} currentSelection="YES" choices={moneyline} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick Washington Commanders to win" }));
    expect(await screen.findByRole("status")).toHaveTextContent("You picked Washington Commanders.");
    expect(screen.getByRole("button", { name: "Pick Washington Commanders to win" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pick Indianapolis Colts to win" })).toHaveAttribute("aria-pressed", "false");
    // No probability of any kind is shown with the confirmation.
    expect(screen.getByRole("status").textContent).not.toMatch(/%|odds|chance|probabilit/i);
  });

  it("falls back to generic labels for a Market the presentation can't describe, without crashing", () => {
    const fallback = getChoicePresentation({}).choices;
    render(<PredictionActions marketId="m1" disabledReason={null} choices={fallback} />);
    expect(screen.getByRole("button", { name: "Pick Yes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pick No" })).toBeInTheDocument();
  });

  it("a disabled control still names its choices and explains why", () => {
    render(<PredictionActions marketId="m1" disabledReason="Picks are locked for this game." choices={total} />);
    expect(screen.getByRole("button", { name: "Pick Over 47.5 total points" })).toBeDisabled();
    expect(screen.getByText("Picks are locked for this game.")).toBeInTheDocument();
  });
});
