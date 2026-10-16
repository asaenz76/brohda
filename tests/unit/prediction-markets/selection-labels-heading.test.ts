import { describe, expect, it } from "vitest";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";

const teams = { homeTeamName: "Houston Texans", awayTeamName: "Jacksonville Jaguars", sport: "american_football" };

describe("the heading a Market is introduced by when several are shown together", () => {
  it("a TOTAL is 'Game Total {line}' with the exact canonical line, never rounded", () => {
    expect(getChoicePresentation({ ...teams, marketTemplate: "TOTAL", yesSide: null, lineValue: 224 }).heading).toBe("Game Total 224");
    expect(getChoicePresentation({ ...teams, marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5 }).heading).toBe("Game Total 47.5");
  });

  it("a SPREAD is 'Spread' (a puck line or run line is the same canonical SPREAD), a Moneyline is 'Moneyline'", () => {
    for (const sport of ["american_football", "basketball", "hockey", "baseball"]) {
      expect(getChoicePresentation({ ...teams, sport, marketTemplate: "SPREAD", yesSide: "HOME", lineValue: -1.5 }).heading).toBe("Spread");
    }
    expect(getChoicePresentation({ ...teams, marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null }).heading).toBe("Moneyline");
  });

  it("is null when the template can't be described — the caller falls back to the question, never a guess", () => {
    expect(getChoicePresentation({}).heading).toBeNull();
    expect(getChoicePresentation({ marketTemplate: "TOTAL", lineValue: null }).heading).toBeNull();
  });
});
