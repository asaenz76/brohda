import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YourPredictionCard } from "@/components/predictions/YourPredictionCard";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import type { Prediction } from "@/lib/predictions/types";

afterEach(() => cleanup());

const choices = getChoicePresentation({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, homeTeamName: "Indianapolis Colts", awayTeamName: "Washington Commanders", sport: "american_football" }).choices;

const graded = (overrides: Partial<Prediction>): Prediction =>
  ({ id: "p1", selectedOutcome: "NO", yesProbabilitySnapshot: 0.6, noProbabilitySnapshot: 0.4, lifecycleState: "GRADED", lockedAt: null, result: null, ...overrides }) as Prediction;

describe("YourPredictionCard — the graded result in the visible choice's words", () => {
  it("a tied Moneyline reads Void, keeps the team labels, and marks neither team correct", () => {
    // A tie grades both stored sides VOID. The viewer's visible Pick is unchanged; only the result line says Void.
    const { container } = render(<YourPredictionCard prediction={graded({ result: "VOID" })} choices={choices} />);
    expect(screen.getByText("You picked: Washington Commanders")).toBeInTheDocument();
    expect(screen.getByText("Result: Void — this one didn't count")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Correct|Incorrect/);
  });

  it("is the same for the other side of the same tied game", () => {
    render(<YourPredictionCard prediction={graded({ selectedOutcome: "YES", result: "VOID" })} choices={choices} />);
    expect(screen.getByText("You picked: Indianapolis Colts")).toBeInTheDocument();
    expect(screen.getByText(/^Result: Void/)).toBeInTheDocument();
  });

  it("a decided result is untouched", () => {
    const { unmount } = render(<YourPredictionCard prediction={graded({ result: "CORRECT" })} choices={choices} />);
    expect(screen.getByText("Result: Correct")).toBeInTheDocument();
    unmount();
    render(<YourPredictionCard prediction={graded({ result: "INCORRECT" })} choices={choices} />);
    expect(screen.getByText("Result: Incorrect")).toBeInTheDocument();
  });
});
