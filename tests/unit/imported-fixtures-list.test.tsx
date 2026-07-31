import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImportedFixturesList, type ImportedFixture } from "@/app/(admin)/admin/fixtures/imported-fixtures-list";

afterEach(() => cleanup());

const fixtures: ImportedFixture[] = [
  {
    id: "f1",
    externalFixtureId: "215662",
    sport: "football",
    homeTeamName: "Arsenal",
    awayTeamName: "Chelsea",
    competitionName: "Premier League",
    competitionCountry: "England",
    scheduledStartUtc: new Date().toISOString(),
    poolCount: 0,
    hidden: false,
  },
  {
    id: "f2",
    externalFixtureId: "998877",
    sport: "football",
    homeTeamName: "Boca",
    awayTeamName: "River",
    competitionName: "Copa Argentina",
    competitionCountry: "Argentina",
    scheduledStartUtc: new Date().toISOString(),
    poolCount: 0,
    hidden: false,
  },
];

describe("ImportedFixturesList fixture ID visibility (super admin only)", () => {
  it("shows every imported fixture's external ID to a super admin", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={true} />);
    expect(screen.getByText("ID: 215662")).toBeInTheDocument();
    expect(screen.getByText("ID: 998877")).toBeInTheDocument();
  });

  it("hides fixture IDs and the ID filter from a regular admin", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={false} />);
    expect(screen.queryByText("ID: 215662")).not.toBeInTheDocument();
    expect(screen.queryByText("ID: 998877")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Fixture ID")).not.toBeInTheDocument();
  });

  it("filters the list down to fixtures matching a typed ID", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={true} />);

    fireEvent.change(screen.getByLabelText("Fixture ID"), { target: { value: "9988" } });

    expect(screen.queryByText("Arsenal vs Chelsea")).not.toBeInTheDocument();
    expect(screen.getByText("Boca vs River")).toBeInTheDocument();
  });

  it("keeps the filter input visible (not the whole component) when no fixture matches", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={true} />);

    fireEvent.change(screen.getByLabelText("Fixture ID"), { target: { value: "no-such-id" } });

    expect(screen.getByLabelText("Fixture ID")).toBeInTheDocument();
    expect(screen.getByText("No imported fixtures match these filters.")).toBeInTheDocument();
  });
});

describe("ImportedFixturesList sport/league filters", () => {
  it("filters the list down to fixtures matching the selected league", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={false} />);

    fireEvent.change(screen.getByLabelText("Filter by league"), {
      target: { value: "Argentina|Copa Argentina" },
    });

    expect(screen.queryByText("Arsenal vs Chelsea")).not.toBeInTheDocument();
    expect(screen.getByText("Boca vs River")).toBeInTheDocument();
  });

  it("disambiguates two leagues with the same name in different countries", () => {
    const sameNameFixtures: ImportedFixture[] = [
      { ...fixtures[0], id: "f3", competitionName: "Primera División", competitionCountry: "Costa Rica" },
      { ...fixtures[1], id: "f4", competitionName: "Primera División", competitionCountry: "Peru" },
    ];
    render(<ImportedFixturesList fixtures={sameNameFixtures} isSuperAdmin={false} />);

    const options = screen.getAllByRole("option", { name: /Primera División/ });
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("Costa Rica | Primera División");
    expect(options[1]).toHaveTextContent("Peru | Primera División");
  });

  it("combines the sport filter with the league filter (both must match)", () => {
    render(<ImportedFixturesList fixtures={fixtures} isSuperAdmin={false} />);

    fireEvent.change(screen.getByLabelText("Filter by sport"), { target: { value: "football" } });
    fireEvent.change(screen.getByLabelText("Filter by league"), {
      target: { value: "England|Premier League" },
    });

    expect(screen.getByText("Arsenal vs Chelsea")).toBeInTheDocument();
    expect(screen.queryByText("Boca vs River")).not.toBeInTheDocument();
  });
});
