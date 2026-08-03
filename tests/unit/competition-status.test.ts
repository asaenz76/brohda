import { describe, expect, it } from "vitest";
import {
  computeOperationalStatus,
  getNeedsAttentionReasons,
  importStatusBadge,
  type CompetitionStatusInput,
} from "@/lib/competitions/status";

function baseInput(overrides: Partial<CompetitionStatusInput> = {}): CompetitionStatusInput {
  return {
    importStatus: "IMPORTED",
    syncStatus: "IDLE",
    isActive: true,
    archivedAt: null,
    seasonEndDate: "2027-05-01",
    lastFixtureDiscoveryAt: new Date().toISOString(),
    upcomingFixtureCount: 5,
    fixtureCountImported: 5,
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

  it("Completed beats Active/Prepared once the season end date has passed", () => {
    const status = computeOperationalStatus(
      baseInput({ seasonEndDate: "2020-01-01", hasFixtureWithinActivationWindow: true }),
    );
    expect(status).toBe("NEEDS_ATTENTION"); // still active (is_active true) + completed -> flagged for archiving
  });

  it("Completed (already archived) does not double-flag as Needs attention", () => {
    const status = computeOperationalStatus(baseInput({ seasonEndDate: "2020-01-01", isActive: false }));
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

  it("No upcoming fixtures when nothing future is known and the season hasn't ended", () => {
    const status = computeOperationalStatus(
      baseInput({ upcomingFixtureCount: 0, seasonEndDate: "2027-05-01", hasFixtureWithinActivationWindow: false }),
    );
    expect(status).toBe("NEEDS_ATTENTION"); // "no upcoming fixtures" is itself a Needs-Attention reason
    expect(getNeedsAttentionReasons(baseInput({ upcomingFixtureCount: 0 }))).toContain("NO_UPCOMING_FIXTURES");
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
