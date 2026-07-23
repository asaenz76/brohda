import { describe, expect, it } from "vitest";
import { getInitials } from "@/lib/utils/initials";

describe("getInitials", () => {
  it("uses first and last name initials", () => {
    expect(getInitials("Andre Saenz")).toBe("AS");
  });

  it("uses first two letters for a single name", () => {
    expect(getInitials("Andre")).toBe("AN");
  });

  it("ignores extra whitespace", () => {
    expect(getInitials("  Andre   Saenz  ")).toBe("AS");
  });

  it("uses first and last of three or more names", () => {
    expect(getInitials("Andre Miguel Saenz")).toBe("AS");
  });

  it("falls back to a placeholder for an empty name", () => {
    expect(getInitials("")).toBe("?");
    expect(getInitials("   ")).toBe("?");
  });
});
