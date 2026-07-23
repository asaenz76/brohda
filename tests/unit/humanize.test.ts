import { describe, expect, it } from "vitest";
import { humanizeEnum } from "@/lib/utils/humanize";

describe("humanizeEnum", () => {
  it("replaces underscores with spaces and sentence-cases the result", () => {
    expect(humanizeEnum("settlement_reversal_debit")).toBe("Settlement reversal debit");
  });

  it("lowercases a SCREAMING_SNAKE_CASE enum value", () => {
    expect(humanizeEnum("MATCH_POSTPONED_NOT_COMPLETED_SAME_DAY")).toBe(
      "Match postponed not completed same day",
    );
  });

  it("handles a single word with no underscores", () => {
    expect(humanizeEnum("admin")).toBe("Admin");
  });

  it("handles super_admin correctly", () => {
    expect(humanizeEnum("super_admin")).toBe("Super admin");
  });
});
