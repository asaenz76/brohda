import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LeagueIdentity } from "@/components/pools/LeagueIdentity";

afterEach(() => cleanup());

const baseProps = {
  competitionName: null,
  competitionCountry: null,
  competitionLogoUrl: null,
};

describe("LeagueIdentity fallback label (no competition, no fixture)", () => {
  it("shows 'Custom Poll' for CUSTOM pools", () => {
    render(<LeagueIdentity {...baseProps} poolType="CUSTOM" />);
    expect(screen.getByText("Custom Poll")).toBeInTheDocument();
  });

  it("shows 'Combo' (not 'Combo Poll') for COMBO pools", () => {
    render(<LeagueIdentity {...baseProps} poolType="COMBO" />);
    expect(screen.getByText("Combo")).toBeInTheDocument();
    expect(screen.queryByText("Combo Poll")).not.toBeInTheDocument();
  });

  it("prefers the real competition name when one exists, regardless of poolType", () => {
    render(<LeagueIdentity {...baseProps} poolType="WHO_WILL_ADVANCE" competitionName="Premier League" />);
    expect(screen.getByText("Premier League")).toBeInTheDocument();
  });

  it("prefixes the competition name with its country when one is known", () => {
    render(
      <LeagueIdentity
        {...baseProps}
        poolType="WHO_WILL_ADVANCE"
        competitionName="1st Division"
        competitionCountry="Albania"
      />,
    );
    expect(screen.getByText("Albania | 1st Division")).toBeInTheDocument();
  });

  it("falls back to the bare competition name when country is unknown", () => {
    render(
      <LeagueIdentity
        {...baseProps}
        poolType="WHO_WILL_ADVANCE"
        competitionName="Premier League"
        competitionCountry={null}
      />,
    );
    expect(screen.getByText("Premier League")).toBeInTheDocument();
  });
});
