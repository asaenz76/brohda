import { describe, expect, it, vi } from "vitest";
import { parseSportParam, serializeSportParam } from "@/app/(admin)/admin/events/sport-param";

vi.mock("server-only", () => ({}));

const ALL = ["american_football", "basketball", "hockey"];

describe("parseSportParam", () => {
  it("defaults to every LIVE sport when omitted (the NFL, NBA and NHL — MLB is declared but not launched)", () => {
    expect(parseSportParam(undefined)).toEqual(ALL);
  });

  it("accepts the league aliases (nfl / nba / nhl) for the raw sport keys", () => {
    expect(parseSportParam("nfl")).toEqual(["american_football"]);
    expect(parseSportParam("nba")).toEqual(["basketball"]);
    expect(parseSportParam("NHL")).toEqual(["hockey"]);
    expect(parseSportParam("nba,nhl")).toEqual(["basketball", "hockey"]);
  });

  it("accepts the raw internal values too", () => {
    expect(parseSportParam("american_football")).toEqual(["american_football"]);
    expect(parseSportParam("basketball")).toEqual(["basketball"]);
    expect(parseSportParam("hockey")).toEqual(["hockey"]);
  });

  it("degrades to every live sport for a malformed/unrecognized value rather than erroring (soccer is retired, MLB is not launched)", () => {
    expect(parseSportParam("football")).toEqual(ALL);
    expect(parseSportParam("baseball")).toEqual(ALL);
    expect(parseSportParam("mlb")).toEqual(ALL);
    expect(parseSportParam("")).toEqual(ALL);
  });
});

describe("serializeSportParam", () => {
  it("round-trips through the league alias for every live sport", () => {
    expect(serializeSportParam(["american_football"])).toBe("nfl");
    expect(serializeSportParam(["basketball", "hockey"])).toBe("nba,nhl");
    for (const sport of ALL) expect(parseSportParam(serializeSportParam([sport as never]))).toEqual([sport]);
  });
});
