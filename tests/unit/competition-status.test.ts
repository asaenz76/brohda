import { describe, expect, it } from "vitest";
import {
  computeOperationalStatus,
  getNeedsAttentionDetails,
  getNeedsAttentionReasons,
  importStatusBadge,
  type CompetitionStatusInput,
} from "@/lib/competitions/status";

function baseInput(overrides: Partial<CompetitionStatusInput> = {}): CompetitionStatusInput {
  return {
    isSupported: true,
    importStatus: "IMPORTED",
    syncStatus: "IDLE",
    isActive: true,
    archivedAt: null,
    seasonEndDate: "2027-05-01",
    lastFixtureDiscoveryAt: new Date().toISOString(),
    upcomingFixtureCount: 5,
    fixtureCountImported: 5,
    providerFixtureCount: 5,
    latestProviderFixtureAt: null,
    isLatestKnownSeason: true,
    discoverySyncIntervalHours: 6,
    hasFixtureWithinActivationWindow: false,
    allKnownFixturesAreTerminal: false,
    ...overrides,
  };
}

describe("importStatusBadge", () => {
  it("maps null (no row) to NOT_IMPORTED", () => {
    expect(importStatusBadge({ importStatus: null })).toBe("NOT_IMPORTED");
  });
  it("passes through IMPORTING/IMPORTED/IMPORT_FAILED as-is", () => {
    expect(importStatusBadge({ importStatus: "IMPORTING" })).toBe("IMPORTING");
    expect(importStatusBadge({ importStatus: "IMPORTED" })).toBe("IMPORTED");
    expect(importStatusBadge({ importStatus: "IMPORT_FAILED" })).toBe("IMPORT_FAILED");
  });
});

describe("computeOperationalStatus — UNSUPPORTED", () => {
  it("returns UNSUPPORTED for an imported competition no longer in SUPPORTED_COMPETITIONS", () => {
    expect(computeOperationalStatus(baseInput({ isSupported: false }))).toBe("UNSUPPORTED");
  });

  it("UNSUPPORTED takes precedence even over Archived — data stays intact but its state is unambiguous either way", () => {
    expect(computeOperationalStatus(baseInput({ isSupported: false, isActive: false }))).toBe("UNSUPPORTED");
  });

  it("never flags any needs-attention reason for an unsupported competition, regardless of stale sync/mismatch data", () => {
    const details = getNeedsAttentionDetails(
      baseInput({ isSupported: false, syncStatus: "FAILED", providerFixtureCount: 999, fixtureCountImported: 0 }),
    );
    expect(details).toEqual([]);
  });
});

describe("computeOperationalStatus", () => {
  it("returns null before a successful import", () => {
    expect(computeOperationalStatus(baseInput({ importStatus: null }))).toBeNull();
    expect(computeOperationalStatus(baseInput({ importStatus: "IMPORTING" }))).toBeNull();
    expect(computeOperationalStatus(baseInput({ importStatus: "IMPORT_FAILED" }))).toBeNull();
  });

  it("Archived beats everything else, even Needs-Attention conditions", () => {
    const status = computeOperationalStatus(baseInput({ isActive: false, syncStatus: "FAILED" }));
    expect(status).toBe("ARCHIVED");
  });

  it("Needs attention beats Active when the last sync failed", () => {
    const status = computeOperationalStatus(baseInput({ syncStatus: "FAILED", hasFixtureWithinActivationWindow: true }));
    expect(status).toBe("NEEDS_ATTENTION");
  });

  it("Needs attention fires when discovery hasn't run in far longer than its own interval", () => {
    const staleDate = new Date(Date.now() - 6 * 3.5 * 3600_000).toISOString(); // 3.5x the 6h interval
    const status = computeOperationalStatus(baseInput({ lastFixtureDiscoveryAt: staleDate }));
    expect(status).toBe("NEEDS_ATTENTION");
    expect(getNeedsAttentionReasons(baseInput({ lastFixtureDiscoveryAt: staleDate }))).toContain("SYNC_STALE");
  });

  it("does not flag stale sync for a normal, recent gap", () => {
    const recentDate = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2h < 6h interval
    expect(getNeedsAttentionReasons(baseInput({ lastFixtureDiscoveryAt: recentDate }))).not.toContain("SYNC_STALE");
  });

  it("Needs attention fires when a newer season is now available", () => {
    const status = computeOperationalStatus(baseInput({ isLatestKnownSeason: false }));
    expect(status).toBe("NEEDS_ATTENTION");
    expect(getNeedsAttentionReasons(baseInput({ isLatestKnownSeason: false }))).toContain("NEWER_SEASON_AVAILABLE");
  });

  it("Needs attention fires when imported fixture count differs from the provider's own count", () => {
    const status = computeOperationalStatus(baseInput({ providerFixtureCount: 20, fixtureCountImported: 5 }));
    expect(status).toBe("NEEDS_ATTENTION");
    expect(getNeedsAttentionReasons(baseInput({ providerFixtureCount: 20 }))).toContain("FIXTURE_COUNT_MISMATCH");
  });

  it("FIXTURE_COUNT_MISMATCH states the real provider and imported counts, not a generic sentence", () => {
    const details = getNeedsAttentionDetails(baseInput({ providerFixtureCount: 40, fixtureCountImported: 32 }));
    expect(details.find((d) => d.code === "FIXTURE_COUNT_MISMATCH")?.message).toBe(
      "API-Football reports 40 fixtures, but 32 are imported.",
    );
  });

  it("Active outranks Completed — a real eligible fixture always wins over an inferred season-over signal", () => {
    // Even if seasonEndDate + a stale-looking latestProviderFixtureAt would
    // otherwise satisfy isCompleted, a genuine upcoming eligible fixture
    // must still win — this is the explicit precedence reordering that
    // fixes the underlying MLS-class bug (see the regression describe
    // block below for the full scenario).
    const status = computeOperationalStatus(
      baseInput({
        seasonEndDate: "2020-01-01",
        latestProviderFixtureAt: "2020-01-01",
        hasFixtureWithinActivationWindow: true,
      }),
    );
    expect(status).toBe("ACTIVE");
  });

  it("Completed beats No-upcoming-fixtures once the season end date has passed and the provider confirms nothing remains", () => {
    const status = computeOperationalStatus(
      baseInput({
        seasonEndDate: "2020-01-01",
        latestProviderFixtureAt: "2020-01-01",
        upcomingFixtureCount: 0,
        hasFixtureWithinActivationWindow: false,
      }),
    );
    expect(status).toBe("COMPLETED");
  });

  it("never marks Completed when latestProviderFixtureAt is unknown (null) — no future imported fixture is not proof the season ended", () => {
    const status = computeOperationalStatus(
      baseInput({
        seasonEndDate: "2020-01-01",
        latestProviderFixtureAt: null,
        upcomingFixtureCount: 0,
        allKnownFixturesAreTerminal: true,
        hasFixtureWithinActivationWindow: false,
      }),
    );
    expect(status).not.toBe("COMPLETED");
  });

  it("shows Completed (not Needs attention) once the provider confirms the season is genuinely over — the archive suggestion is advisory, surfaced separately, not a badge override", () => {
    const input = baseInput({
      seasonEndDate: "2020-01-01",
      latestProviderFixtureAt: "2020-01-01",
      upcomingFixtureCount: 0,
      isActive: true,
    });
    expect(computeOperationalStatus(input)).toBe("COMPLETED");
    expect(getNeedsAttentionReasons(input)).toContain("SEASON_ENDED_NOT_ARCHIVED");
  });

  it("Completed (already archived) does not double-flag as Needs attention", () => {
    const status = computeOperationalStatus(
      baseInput({ seasonEndDate: "2020-01-01", latestProviderFixtureAt: "2020-01-01", isActive: false }),
    );
    expect(status).toBe("ARCHIVED");
  });

  it("Active when a fixture falls within the activation window", () => {
    const status = computeOperationalStatus(baseInput({ hasFixtureWithinActivationWindow: true }));
    expect(status).toBe("ACTIVE");
  });

  it("Prepared when future fixtures exist but none within the activation window", () => {
    const status = computeOperationalStatus(baseInput({ hasFixtureWithinActivationWindow: false, upcomingFixtureCount: 3 }));
    expect(status).toBe("PREPARED");
  });

  it("shows No-upcoming-fixtures (not Needs attention) when nothing future is known and the season end date is unset — the reason is advisory, surfaced separately", () => {
    const input = baseInput({ upcomingFixtureCount: 0, seasonEndDate: null, hasFixtureWithinActivationWindow: false });
    expect(computeOperationalStatus(input)).toBe("NO_UPCOMING_FIXTURES");
    expect(getNeedsAttentionReasons(input)).toContain("NO_UPCOMING_FIXTURES");
  });

  it("flags a precise metadata-conflict reason (not NO_UPCOMING_FIXTURES) when the season end date is still in the future but nothing upcoming is imported", () => {
    const details = getNeedsAttentionDetails(
      baseInput({ upcomingFixtureCount: 0, seasonEndDate: "2027-05-01", hasFixtureWithinActivationWindow: false }),
    );
    expect(details.map((d) => d.code)).toContain("SEASON_METADATA_CONFLICT");
    expect(details.map((d) => d.code)).not.toContain("NO_UPCOMING_FIXTURES");
    expect(details.find((d) => d.code === "SEASON_METADATA_CONFLICT")?.message).toMatch(/Provider season ends on/);
  });

  it("flags UPCOMING_FIXTURES_NOT_IMPORTED (not SEASON_METADATA_CONFLICT) when nothing has been imported at all yet — a real production incident where two competitions with 0 imported fixtures showed a misleading metadata-conflict message", () => {
    const details = getNeedsAttentionDetails(
      baseInput({ upcomingFixtureCount: 0, fixtureCountImported: 0, providerFixtureCount: 0, seasonEndDate: "2027-05-01" }),
    );
    expect(details.map((d) => d.code)).toContain("UPCOMING_FIXTURES_NOT_IMPORTED");
    expect(details.map((d) => d.code)).not.toContain("SEASON_METADATA_CONFLICT");
    const detail = details.find((d) => d.code === "UPCOMING_FIXTURES_NOT_IMPORTED");
    expect(detail?.message).toMatch(/No fixtures have been imported/);
    expect(detail?.action).toBe("RUN_DISCOVERY");
  });

  it("still flags the real SEASON_METADATA_CONFLICT when fixtures ARE imported but none are upcoming despite the season not having ended", () => {
    const details = getNeedsAttentionDetails(
      baseInput({ upcomingFixtureCount: 0, fixtureCountImported: 12, providerFixtureCount: 12, seasonEndDate: "2027-05-01" }),
    );
    expect(details.map((d) => d.code)).toContain("SEASON_METADATA_CONFLICT");
    expect(details.map((d) => d.code)).not.toContain("UPCOMING_FIXTURES_NOT_IMPORTED");
  });
});

describe("getNeedsAttentionReasons", () => {
  it("returns just IMPORT_FAILED for a failed import, nothing else", () => {
    expect(getNeedsAttentionReasons(baseInput({ importStatus: "IMPORT_FAILED" }))).toEqual(["IMPORT_FAILED"]);
  });

  it("returns no reasons for a healthy, active competition", () => {
    expect(getNeedsAttentionReasons(baseInput({ hasFixtureWithinActivationWindow: true }))).toEqual([]);
  });

  it("can surface multiple reasons at once", () => {
    const reasons = getNeedsAttentionReasons(
      baseInput({ syncStatus: "FAILED", isLatestKnownSeason: false, upcomingFixtureCount: 0, seasonEndDate: null }),
    );
    expect(reasons).toContain("SYNC_FAILED");
    expect(reasons).toContain("NEWER_SEASON_AVAILABLE");
    expect(reasons).toContain("NO_UPCOMING_FIXTURES");
  });
});

describe("getNeedsAttentionDetails", () => {
  it("every detail carries a precise, evidence-bearing message and a resolving action", () => {
    const staleDate = new Date(Date.now() - 30 * 3600_000).toISOString();
    const details = getNeedsAttentionDetails(baseInput({ lastFixtureDiscoveryAt: staleDate }));
    const stale = details.find((d) => d.code === "SYNC_STALE");
    expect(stale?.message).toMatch(/Fixture discovery has not run in \d+ hours?\./);
    expect(stale?.action).toBe("RUN_DISCOVERY");
  });

  it("SEASON_ENDED_NOT_ARCHIVED includes the real end date in its message", () => {
    const details = getNeedsAttentionDetails(
      baseInput({ seasonEndDate: "2026-01-15", latestProviderFixtureAt: "2026-01-15", upcomingFixtureCount: 0 }),
    );
    const reason = details.find((d) => d.code === "SEASON_ENDED_NOT_ARCHIVED");
    expect(reason?.message).toContain("January 15, 2026");
    expect(reason?.action).toBe("ARCHIVE");
  });
});

// Regression coverage for the real production bug: MLS 2026 was shown as
// "Season has ended" despite being a healthy, ongoing season. Root cause
// was two-fold — (1) the list page's bulk fixtures query silently
// truncated past PostgREST's 1000-row default cap, dropping MLS's future
// fixtures from the aggregate on some requests, and (2) isCompleted()
// treated "every fixture we happen to have imported is terminal" as
// sufficient proof the season was over, with no cross-check against the
// provider's own schedule. This suite locks in the fix for (2); the RPC
// fix for (1) is exercised against a real database in
// tests/unit/manager-data.test.ts's fixtureAggregatesFromRpcRows coverage.
describe("regression: an in-season annual league with no currently-imported future fixture", () => {
  it("is not marked Completed just because none of its imported fixtures are upcoming", () => {
    // Mirrors MLS's real production shape: season_end_date unset, every
    // fixture we've imported so far happens to be in the past/terminal,
    // but discovery has never confirmed the provider has no more games —
    // latestProviderFixtureAt is null (never checked yet).
    const status = computeOperationalStatus(
      baseInput({
        seasonEndDate: null,
        latestProviderFixtureAt: null,
        fixtureCountImported: 268,
        upcomingFixtureCount: 0,
        allKnownFixturesAreTerminal: true,
        hasFixtureWithinActivationWindow: false,
      }),
    );
    expect(status).not.toBe("COMPLETED");
  });

  it("resolves to Active once discovery actually confirms an upcoming fixture in the activation window (the real fix's healthy end state)", () => {
    const status = computeOperationalStatus(
      baseInput({
        seasonEndDate: null,
        latestProviderFixtureAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        fixtureCountImported: 510,
        providerFixtureCount: 510,
        upcomingFixtureCount: 242,
        allKnownFixturesAreTerminal: false,
        hasFixtureWithinActivationWindow: true,
      }),
    );
    expect(status).toBe("ACTIVE");
  });
});
