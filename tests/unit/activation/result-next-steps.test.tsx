import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ResultNextSteps } from "@/components/predictions/ResultNextSteps";

afterEach(() => cleanup());

describe("ResultNextSteps — under a result", () => {
  it("shows the Record, and a way to the next Pick; no weekly line while the leaderboard is off", () => {
    render(<ResultNextSteps data={{ record: { correct: 7, incorrect: 3 }, weekly: null }} />);
    expect(screen.getByText(/Your Record is/).closest("p")).toHaveTextContent("Your Record is 7–3.");
    expect(screen.getByRole("link", { name: "See your Record" })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("link", { name: "Pick another game" })).toHaveAttribute("href", "/feed");
    expect(document.querySelector('[data-slot="result-weekly"]')).toBeNull();
  });

  it("says DECIDED Picks toward the weekly minimum (never counts a waiting Pick), with the real numbers, and links the board", () => {
    render(<ResultNextSteps data={{ record: { correct: 1, incorrect: 0 }, weekly: { ranked: false, rank: null, decided: 1, needed: 4, minDecided: 5 } }} />);
    const line = document.querySelector('[data-slot="result-weekly"]')!;
    expect(line).toHaveTextContent("1 of 5 decided Picks this week to qualify for the leaderboard.");
    expect(line.textContent).not.toMatch(/\b5 of 5\b/);
    expect(screen.getByRole("link", { name: "Weekly leaderboard" })).toHaveAttribute("href", "/leaderboard");
  });

  it("a ranked Member sees their place", () => {
    render(<ResultNextSteps data={{ record: { correct: 8, incorrect: 2 }, weekly: { ranked: true, rank: 3, decided: 10, needed: 0, minDecided: 5 } }} />);
    expect(document.querySelector('[data-slot="result-weekly"]')).toHaveTextContent("You're #3 on this week's leaderboard.");
  });

  it("uses no pressure, points or money language", () => {
    const { container } = render(<ResultNextSteps data={{ record: { correct: 0, incorrect: 1 }, weekly: { ranked: false, rank: null, decided: 1, needed: 4, minDecided: 5 } }} />);
    expect(container.textContent).not.toMatch(/\bpoints?\b|\bxp\b|streak|hurry|don't miss|lose|last chance|\$|\bbet|wager|prize/i);
  });
});
