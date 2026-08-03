import { describe, expect, it } from "vitest";
import { buildImportChunks, chunkPayloadBytes } from "@/lib/competitions/import-chunks";
import { IMPORT_CHUNK_MAX_BYTES, IMPORT_CHUNK_MAX_FIXTURES } from "@/lib/competitions/constants";
import type { NormalizedFixture } from "@/lib/sports-data/types";

function fixture(externalFixtureId: string, overrides: Partial<NormalizedFixture> = {}): NormalizedFixture {
  return {
    provider: "api_football",
    externalFixtureId,
    sport: "football",
    competitionExternalId: "39",
    competitionName: "Premier League",
    competitionCountry: "England",
    competitionLogoUrl: null,
    season: "2025",
    round: "Regular Season - 1",
    homeTeamExternalId: "42",
    homeTeamName: "Arsenal",
    homeTeamLogoUrl: null,
    awayTeamExternalId: "33",
    awayTeamName: "Manchester United",
    awayTeamLogoUrl: null,
    venueName: null,
    venueCity: null,
    venueTimezone: null,
    scheduledStartUtc: "2026-08-15T14:00:00.000Z",
    providerTimezone: "UTC",
    providerStatusCode: "NS",
    providerStatusDescription: "Not Started",
    internalStatus: "NOT_STARTED",
    elapsedMinutes: null,
    homeScore: null,
    awayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
    regulationHomeScore: null,
    regulationAwayScore: null,
    extraTimeHomeScore: null,
    extraTimeAwayScore: null,
    penaltyHomeScore: null,
    penaltyAwayScore: null,
    providerPayload: {},
    ...overrides,
  };
}

describe("buildImportChunks", () => {
  it("returns one chunk when everything fits comfortably", () => {
    const fixtures = Array.from({ length: 5 }, (_, i) => fixture(String(i)));
    const chunks = buildImportChunks(fixtures);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it("splits at the fixture-count bound", () => {
    const fixtures = Array.from({ length: IMPORT_CHUNK_MAX_FIXTURES + 10 }, (_, i) => fixture(String(i)));
    const chunks = buildImportChunks(fixtures);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(IMPORT_CHUNK_MAX_FIXTURES);
    expect(chunks[1]).toHaveLength(10);
  });

  it("splits at the byte-size bound even when well under the count bound", () => {
    // A handful of fixtures with an artificially huge embedded raw payload
    // — well under IMPORT_CHUNK_MAX_FIXTURES, but each one alone is a
    // meaningful fraction of IMPORT_CHUNK_MAX_BYTES.
    const bigPayload = { raw: "x".repeat(Math.floor(IMPORT_CHUNK_MAX_BYTES / 3)) };
    const fixtures = Array.from({ length: 5 }, (_, i) => fixture(String(i), { providerPayload: bigPayload }));
    const chunks = buildImportChunks(fixtures);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunkPayloadBytes(chunk)).toBeLessThanOrEqual(IMPORT_CHUNK_MAX_BYTES * 1.1); // small slack for JSON overhead
    }
  });

  it("never drops a fixture, even one larger than the byte bound on its own", () => {
    const hugeFixture = fixture("huge", { providerPayload: { raw: "x".repeat(IMPORT_CHUNK_MAX_BYTES * 2) } });
    const chunks = buildImportChunks([fixture("a"), hugeFixture, fixture("b")]);
    const allIds = chunks.flat().map((f) => f.externalFixtureId);
    expect(allIds).toEqual(["a", "huge", "b"]);
    // The oversized fixture gets its own chunk rather than being merged
    // with neighbors or dropped.
    const hugeChunk = chunks.find((c) => c.some((f) => f.externalFixtureId === "huge"));
    expect(hugeChunk).toHaveLength(1);
  });

  it("returns an empty array for no fixtures", () => {
    expect(buildImportChunks([])).toEqual([]);
  });
});
