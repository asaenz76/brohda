import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PredictionActions } from "@/components/predictions/PredictionActions";

afterEach(() => cleanup());

vi.mock("@/lib/actions/predictions", () => ({
  submitPredictionAction: vi.fn(),
}));

// Phase C (Brohda 2.0 redesign, spec §39) — regression guard for the
// mobile Pick-button overflow bug found in the Phase B visual sweep: two
// buttons with long semantic labels overflowed a 375px card rather than
// wrapping. Fixed by stacking full-width below `sm` and reverting to an
// inline auto-width row at `sm`+ — this checks the classes that fix
// actually landed, not layout pixels (jsdom has no real layout engine).
describe("PredictionActions mobile overflow fix", () => {
  it("stacks full-width below sm and reverts to auto width at sm+", () => {
    render(<PredictionActions marketId="m1" disabledReason={null} yesLabel="Home Test NFL win" noLabel="Home Test NFL do not win" />);
    const yes = screen.getByRole("button", { name: "Pick: Home Test NFL win" });
    const no = screen.getByRole("button", { name: "Pick: Home Test NFL do not win" });
    expect(yes).toHaveClass("w-full", "sm:w-auto");
    expect(no).toHaveClass("w-full", "sm:w-auto");
    expect(yes.parentElement).toHaveClass("flex-col", "sm:flex-row");
  });

  it("still uses semantic labels for both the visible text and the accessible name, never raw YES/NO", () => {
    render(<PredictionActions marketId="m1" disabledReason={null} yesLabel="Chiefs win" noLabel="Bills win" />);
    expect(screen.getByRole("button", { name: "Pick: Chiefs win" })).toHaveTextContent("Chiefs win");
    expect(screen.getByRole("button", { name: "Pick: Bills win" })).toHaveTextContent("Bills win");
    expect(screen.queryByText(/^YES$/)).toBeNull();
    expect(screen.queryByText(/^NO$/)).toBeNull();
  });
});
