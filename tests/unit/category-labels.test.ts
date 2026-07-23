import { describe, expect, it } from "vitest";
import { resolvePoolCategoryLabel } from "@/lib/pools/templates/category-labels";

describe("resolvePoolCategoryLabel", () => {
  it("maps a TEMPLATE_GRADED row to its registry category label", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "WINNING_MARGIN")).toBe("Goals");
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "RED_CARD")).toBe("Cards");
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "PLAYER_TO_SCORE")).toBe("Players");
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "HOME_TEAM_TO_WIN")).toBe("Match result");
  });

  it("maps the 4 legacy pool_type values to their display categories", () => {
    expect(resolvePoolCategoryLabel("WHO_WILL_ADVANCE", null)).toBe("Match result");
    expect(resolvePoolCategoryLabel("REGULATION_RESULT", null)).toBe("Match result");
    expect(resolvePoolCategoryLabel("COMBO", null)).toBe("Combos");
    expect(resolvePoolCategoryLabel("CUSTOM", null)).toBe("Custom props");
  });

  it("falls back to Other for an unrecognized template id", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "NOT_A_REAL_TEMPLATE")).toBe("Other");
  });

  it("falls back to Other for a TEMPLATE_GRADED row with a null template_id", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", null)).toBe("Other");
  });
});
