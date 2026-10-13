import { describe, expect, it } from "vitest";
import { expectedCommunityLinksPerPost } from "@/lib/communities/distribution";

// The one definition of "a fully distributed Post": the reconciliation job leaves a Post alone once it carries this many Community links.
describe("expectedCommunityLinksPerPost", () => {
  it("counts home + away team, league and sport when every flag is on", () => {
    expect(expectedCommunityLinksPerPost({ teamEnabled: true, leagueEnabled: true, sportEnabled: true })).toBe(4);
  });

  it("counts only the targets whose own policy flag is on", () => {
    expect(expectedCommunityLinksPerPost({ teamEnabled: true, leagueEnabled: false, sportEnabled: false })).toBe(2);
    expect(expectedCommunityLinksPerPost({ teamEnabled: false, leagueEnabled: true, sportEnabled: false })).toBe(1);
    expect(expectedCommunityLinksPerPost({ teamEnabled: false, leagueEnabled: false, sportEnabled: true })).toBe(1);
    expect(expectedCommunityLinksPerPost({ teamEnabled: true, leagueEnabled: true, sportEnabled: false })).toBe(3);
  });

  it("expects nothing when every flag is off", () => {
    expect(expectedCommunityLinksPerPost({ teamEnabled: false, leagueEnabled: false, sportEnabled: false })).toBe(0);
  });
});
