import { describe, expect, it } from "vitest";
import {
  getMatchupSeparator,
  isAwayFirstSport,
  orderTeamsForDisplay,
} from "@/lib/sports-data/team-display-order";

describe("team-display-order", () => {
  it("orders football home-first, matching broadcast convention", () => {
    expect(isAwayFirstSport("football")).toBe(false);
    expect(getMatchupSeparator("football")).toBe("vs");
    expect(orderTeamsForDisplay("football", "Home", "Away")).toEqual(["Home", "Away"]);
  });

  it("orders american_football away-first, matching broadcast convention", () => {
    expect(isAwayFirstSport("american_football")).toBe(true);
    expect(getMatchupSeparator("american_football")).toBe("@");
    expect(orderTeamsForDisplay("american_football", "Home", "Away")).toEqual(["Away", "Home"]);
  });
});
