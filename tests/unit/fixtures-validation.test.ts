import { describe, expect, it } from "vitest";
import { fixtureSearchSchema, importFixturesSchema, teamSearchSchema } from "@/lib/validations/fixtures";

describe("fixtureSearchSchema", () => {
  it("accepts a valid by_id search", () => {
    expect(
      fixtureSearchSchema.safeParse({ mode: "by_id", externalFixtureId: "215662" }).success,
    ).toBe(true);
  });

  it("rejects by_id mode with no fixture id", () => {
    expect(fixtureSearchSchema.safeParse({ mode: "by_id" }).success).toBe(false);
  });

  it("accepts a valid by_league search", () => {
    expect(
      fixtureSearchSchema.safeParse({
        mode: "by_league",
        competitionExternalId: "39",
        season: "2024",
      }).success,
    ).toBe(true);
  });

  it("rejects by_league mode missing season", () => {
    expect(
      fixtureSearchSchema.safeParse({ mode: "by_league", competitionExternalId: "39" }).success,
    ).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(
      fixtureSearchSchema.safeParse({
        mode: "by_league",
        competitionExternalId: "39",
        season: "2024",
        date: "04-25-2024",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed season", () => {
    expect(
      fixtureSearchSchema.safeParse({
        mode: "by_league",
        competitionExternalId: "39",
        season: "24",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid by_team search with no season/date (defaults to next 10 upstream)", () => {
    expect(fixtureSearchSchema.safeParse({ mode: "by_team", teamExternalId: "42" }).success).toBe(true);
  });

  it("rejects by_team mode with no team id", () => {
    expect(fixtureSearchSchema.safeParse({ mode: "by_team" }).success).toBe(false);
  });
});

describe("teamSearchSchema", () => {
  it("accepts a non-empty query", () => {
    expect(teamSearchSchema.safeParse({ query: "Arsenal" }).success).toBe(true);
  });

  it("rejects an empty query", () => {
    expect(teamSearchSchema.safeParse({ query: "" }).success).toBe(false);
  });
});

describe("importFixturesSchema", () => {
  it("accepts a single fixture id", () => {
    expect(importFixturesSchema.safeParse(["215662"]).success).toBe(true);
  });

  it("accepts multiple fixture ids for bulk import", () => {
    expect(importFixturesSchema.safeParse(["215662", "215663", "215664"]).success).toBe(true);
  });

  it("rejects an empty array", () => {
    expect(importFixturesSchema.safeParse([]).success).toBe(false);
  });

  it("rejects an empty fixture id", () => {
    expect(importFixturesSchema.safeParse([""]).success).toBe(false);
  });

  it("rejects more than 50 fixture ids", () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i));
    expect(importFixturesSchema.safeParse(ids).success).toBe(false);
  });
});
