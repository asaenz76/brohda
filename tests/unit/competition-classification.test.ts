import { describe, expect, it } from "vitest";
import { classifyCompetition } from "@/lib/fixtures/competition-classification";

describe("classifyCompetition", () => {
  it("flags a competition explicitly named Friendlies", () => {
    const result = classifyCompetition("Friendlies");
    expect(result.isFriendly).toBe(true);
    expect(result.isYouth).toBe(false);
    expect(result.isReserve).toBe(false);
  });

  it("flags Friendlies Women too (plural form)", () => {
    expect(classifyCompetition("Friendlies Women").isFriendly).toBe(true);
  });

  it("flags a U19/U20/U21/U23 age-grade competition", () => {
    expect(classifyCompetition("UEFA U19 Championship").isYouth).toBe(true);
    expect(classifyCompetition("UEFA U21 Championship").isYouth).toBe(true);
    expect(classifyCompetition("Copa U23").isYouth).toBe(true);
  });

  it("flags a competition named Youth League", () => {
    expect(classifyCompetition("UEFA Youth League").isYouth).toBe(true);
  });

  it("flags a reserve team by trailing 'II' or 'B' in a team name", () => {
    expect(classifyCompetition("Segunda Federación", ["Barcelona II", "Sevilla Atlético"]).isReserve).toBe(true);
    expect(classifyCompetition("Championship", ["Real Sociedad B", "Girona"]).isReserve).toBe(true);
  });

  it("flags a competition explicitly named Reserve League", () => {
    expect(classifyCompetition("Premier League 2 Reserve").isReserve).toBe(true);
  });

  it("does not false-positive on ordinary senior league/team names", () => {
    const result = classifyCompetition("Premier League", ["Arsenal", "Manchester United"]);
    expect(result).toEqual({ isFriendly: false, isYouth: false, isReserve: false });
  });

  it("does not false-positive 'reserve' pattern on a team name that merely ends in a B-containing word", () => {
    expect(classifyCompetition("Belgian Pro League", ["Club Brugge", "Cercle Brugge"]).isReserve).toBe(false);
  });

  it("returns all-false for null competition name and no team names", () => {
    expect(classifyCompetition(null)).toEqual({ isFriendly: false, isYouth: false, isReserve: false });
  });
});
