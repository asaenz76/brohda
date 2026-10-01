import { describe, expect, it } from "vitest";
import { resolvePoolCategoryLabel } from "@/lib/pools/templates/category-labels";

describe("resolvePoolCategoryLabel", () => {
  it("maps a TEMPLATE_GRADED row to its registry category label", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "NFL_SPREAD")).toBe("Goals");
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

  // This function is only ever called at pool-creation time (see its own
  // doc comment), always with a template id that was just validated as
  // activeForCreation earlier in the same action — an unknown template can
  // never actually reach it in production. RED_CARD/PLAYER_TO_SCORE were
  // Association-football-only templates, fully removed from the registry
  // when soccer support was retired — this locks in that a since-removed
  // id resolves the same way any other unrecognized id does, rather than
  // throwing or silently miscategorizing.
  it("falls back to Other for a template no longer in the registry", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "RED_CARD")).toBe("Other");
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", "PLAYER_TO_SCORE")).toBe("Other");
  });

  it("falls back to Other for a TEMPLATE_GRADED row with a null template_id", () => {
    expect(resolvePoolCategoryLabel("TEMPLATE_GRADED", null)).toBe("Other");
  });
});
