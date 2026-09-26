import { describe, expect, it } from "vitest";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";

/**
 * Stage 4A remediation (Stage 4 audit §12 — "{community.type} renders the
 * literal string TEAM/LEAGUE/SPORT"). Pure mapping, no I/O: the DB enum
 * value itself is untouched, only the presentation layer translates it.
 */
describe("getCommunityTypeLabel", () => {
  it("(L) never returns the raw enum value verbatim", () => {
    expect(getCommunityTypeLabel("TEAM")).not.toBe("TEAM");
    expect(getCommunityTypeLabel("LEAGUE")).not.toBe("LEAGUE");
    expect(getCommunityTypeLabel("SPORT")).not.toBe("SPORT");
  });

  it("maps each Community type to its human-readable label", () => {
    expect(getCommunityTypeLabel("TEAM")).toBe("Team");
    expect(getCommunityTypeLabel("LEAGUE")).toBe("League");
    expect(getCommunityTypeLabel("SPORT")).toBe("Sport");
  });
});
