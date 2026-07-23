import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolOptionButton } from "@/components/pools/PoolOptionButton";

afterEach(() => cleanup());

describe("PoolOptionButton", () => {
  it("renders the percentage and the live 'Win $X' estimate side by side", () => {
    render(
      <PoolOptionButton
        label="Team Alpha"
        logoUrl={null}
        percentage={30}
        estimatedPayout={1800}
        isCurrentUserChoice={false}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("Win $18.00")).toBeInTheDocument();
  });

  it("shows the percentage without a payout estimate when the option has zero entries", () => {
    render(
      <PoolOptionButton
        label="Team Beta"
        logoUrl={null}
        percentage={0}
        estimatedPayout={null}
        isCurrentUserChoice={false}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText(/Win \$/)).not.toBeInTheDocument();
  });

  it("renders neither percentage nor payout before distribution is visible", () => {
    render(
      <PoolOptionButton
        label="Team Gamma"
        logoUrl={null}
        percentage={null}
        estimatedPayout={null}
        isCurrentUserChoice={false}
        disabled={false}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Win \$/)).not.toBeInTheDocument();
  });
});
