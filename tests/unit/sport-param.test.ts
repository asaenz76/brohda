import { describe, expect, it } from "vitest";
import { parseSportParam, serializeSportParam } from "@/app/(admin)/admin/events/sport-param";

describe("parseSportParam", () => {
  it("defaults to every sport when omitted", () => {
    expect(parseSportParam(undefined)).toEqual(["football", "american_football"]);
  });

  it("accepts the nfl alias for american_football", () => {
    expect(parseSportParam("nfl")).toEqual(["american_football"]);
  });

  it("accepts the raw internal value too", () => {
    expect(parseSportParam("american_football")).toEqual(["american_football"]);
  });

  it("accepts a comma-separated combination", () => {
    expect(parseSportParam("football,nfl")).toEqual(["football", "american_football"]);
  });

  it("degrades to every sport for a malformed/unrecognized value rather than erroring", () => {
    expect(parseSportParam("basketball")).toEqual(["football", "american_football"]);
    expect(parseSportParam("")).toEqual(["football", "american_football"]);
  });
});

describe("serializeSportParam", () => {
  it("round-trips through the nfl alias", () => {
    expect(serializeSportParam(["american_football"])).toBe("nfl");
    expect(parseSportParam(serializeSportParam(["american_football"]))).toEqual(["american_football"]);
  });

  it("serializes football as-is", () => {
    expect(serializeSportParam(["football"])).toBe("football");
  });
});
