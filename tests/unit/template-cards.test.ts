import { describe, expect, it } from "vitest";
import { ALL_CARDS, CATEGORY_LABELS, TABS } from "@/app/(admin)/admin/pools/new/template-cards";

describe("template-cards", () => {
  it("every card carries a Question Family (or null only for none)", () => {
    for (const card of ALL_CARDS) {
      expect(card.family, card.id).not.toBeUndefined();
    }
  });

  it("moves WHO_WILL_ADVANCE/REGULATION_RESULT into their own TRADITIONAL category, separate from the registry MATCH_RESULT templates", () => {
    const whoWillAdvance = ALL_CARDS.find((c) => c.id === "WHO_WILL_ADVANCE")!;
    const regulationResult = ALL_CARDS.find((c) => c.id === "REGULATION_RESULT")!;
    const homeTeamToWin = ALL_CARDS.find((c) => c.id === "HOME_TEAM_TO_WIN")!;

    expect(whoWillAdvance.category).toBe("TRADITIONAL");
    expect(regulationResult.category).toBe("TRADITIONAL");
    expect(homeTeamToWin.category).toBe("MATCH_RESULT");

    // Still the same Question Family — duplicate/mirror detection must
    // keep catching the overlap even though they're in different tabs now.
    expect(whoWillAdvance.family).toBe("MATCH_RESULT");
    expect(homeTeamToWin.family).toBe("MATCH_RESULT");
  });

  it("TABS includes TRADITIONAL and every category has a label", () => {
    expect(TABS).toContain("TRADITIONAL");
    for (const tab of TABS) {
      expect(CATEGORY_LABELS[tab]).toBeTruthy();
    }
  });
});
