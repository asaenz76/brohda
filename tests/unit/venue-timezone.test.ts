import { describe, expect, it } from "vitest";
import { mappedVenueTimezone, resolveVenueTimezone, trustedVenueTimezone } from "@/lib/sports-data/timezone";

describe("venue timezone: the map, and when a stored timezone can be trusted", () => {
  it("the NFL's international and previously missing venues map to their real timezone, not the platform fallback", () => {
    expect(mappedVenueTimezone("Saint-Denis")).toBe("Europe/Paris");
    expect(mappedVenueTimezone("London")).toBe("Europe/London");
    expect(mappedVenueTimezone("Orchard Park")).toBe("America/New_York");
    expect(mappedVenueTimezone("Miami Gardens")).toBe("America/New_York");
    expect(mappedVenueTimezone("Mexico City")).toBe("America/Mexico_City");
    expect(mappedVenueTimezone("Munich")).toBe("Europe/Berlin");
    expect(mappedVenueTimezone("Rio De Janeiro")).toBe("America/Sao_Paulo");
    expect(mappedVenueTimezone("Melbourne")).toBe("Australia/Melbourne");
    expect(resolveVenueTimezone("Saint-Denis", null)).toBe("Europe/Paris");
  });
  it("an unmapped city is not mapped (null); the stored fallback still exists for the platform's own rules", () => {
    expect(mappedVenueTimezone("Atlantis")).toBeNull();
    expect(mappedVenueTimezone(null)).toBeNull();
    expect(resolveVenueTimezone("Atlantis", null)).toBe(process.env.DEFAULT_TIMEZONE || "America/Costa_Rica");
  });
  it("a stored timezone is trusted for a local kickoff time only when it is what the map gives the venue's city", () => {
    expect(trustedVenueTimezone("New Orleans", "America/Chicago")).toBe("America/Chicago");
    expect(trustedVenueTimezone("Saint-Denis", "America/Costa_Rica")).toBeNull(); // the old fallback value for a Paris game
    expect(trustedVenueTimezone("Saint-Denis", "Europe/Paris")).toBe("Europe/Paris");
    expect(trustedVenueTimezone(null, "America/Costa_Rica")).toBeNull(); // NBA/NHL rows: no venue from the provider
    expect(trustedVenueTimezone("Atlantis", "America/Costa_Rica")).toBeNull();
  });
});
