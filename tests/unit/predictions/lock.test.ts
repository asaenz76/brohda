import { describe, expect, it } from "vitest";
import { computeEffectiveLockAt, isPastEffectiveLock, arePredictionsClosed, pickLockState } from "@/lib/predictions/lock";

describe("computeEffectiveLockAt", () => {
  it("subtracts the configured minutes from kickoff", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 10).toISOString()).toBe("2026-01-01T18:50:00.000Z");
  });

  it("supports a zero-minute cutoff (locks exactly at kickoff)", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 0).toISOString()).toBe(kickoff);
  });

  it("is a pure function of its inputs", () => {
    const kickoff = "2026-01-01T19:00:00.000Z";
    expect(computeEffectiveLockAt(kickoff, 10)).toEqual(computeEffectiveLockAt(kickoff, 10));
  });
});

describe("isPastEffectiveLock", () => {
  const kickoff = "2026-01-01T19:00:00.000Z"; // effective lock at 18:50 with a 10-minute cutoff

  it("is false comfortably before the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:00:00.000Z"))).toBe(false);
  });

  it("is false one millisecond before the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:49:59.999Z"))).toBe(false);
  });

  it("is true exactly at the cutoff instant", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T18:50:00.000Z"))).toBe(true);
  });

  it("is true after the cutoff", () => {
    expect(isPastEffectiveLock(kickoff, 10, new Date("2026-01-01T19:30:00.000Z"))).toBe(true);
  });
});

describe("arePredictionsClosed (what may be shown once new predictions can no longer happen)", () => {
  const kickoff = "2026-10-18T13:30:00.000Z";
  it("is open before the effective lock and closed at/after it (kickoff minus the configured minutes)", () => {
    expect(arePredictionsClosed({ internalStatus: "NOT_STARTED", scheduledStartUtc: kickoff }, 10, new Date("2026-10-18T13:19:59.000Z"))).toBe(false);
    expect(arePredictionsClosed({ internalStatus: "NOT_STARTED", scheduledStartUtc: kickoff }, 10, new Date("2026-10-18T13:20:00.000Z"))).toBe(true);
  });
  it("follows the configured lock minutes, not a hard-coded kickoff", () => {
    expect(arePredictionsClosed({ internalStatus: "NOT_STARTED", scheduledStartUtc: kickoff }, 0, new Date("2026-10-18T13:29:00.000Z"))).toBe(false);
    expect(arePredictionsClosed({ internalStatus: "NOT_STARTED", scheduledStartUtc: kickoff }, 60, new Date("2026-10-18T12:45:00.000Z"))).toBe(true);
  });
  it("is closed for any Game that is no longer NOT_STARTED, whatever the clock says (the server's status decides)", () => {
    expect(arePredictionsClosed({ internalStatus: "LIVE", scheduledStartUtc: "2030-01-01T00:00:00.000Z" }, 10, new Date("2026-10-18T00:00:00.000Z"))).toBe(true);
    expect(arePredictionsClosed({ internalStatus: "COMPLETED", scheduledStartUtc: kickoff }, 10, new Date("2026-10-17T00:00:00.000Z"))).toBe(true);
  });
});

describe("pickLockState — what the Pick controls show", () => {
  const game = { internalStatus: "NOT_STARTED", scheduledStartUtc: "2026-10-18T20:05:00.000Z" };

  it("is open, and says when it locks, before the lock", () => {
    expect(pickLockState(game, 10, new Date("2026-10-18T19:50:00.000Z"))).toEqual({ closed: false, lockAt: "2026-10-18T19:55:00.000Z" });
  });

  it("is closed from the lock instant, even though the provider still reports the Game as NOT_STARTED (it reports 'live' only after kickoff)", () => {
    expect(pickLockState(game, 10, new Date("2026-10-18T19:55:00.000Z"))).toEqual({ closed: true, lockAt: null });
    expect(pickLockState(game, 10, new Date("2026-10-18T20:04:00.000Z")).closed).toBe(true);
    expect(pickLockState(game, 10, new Date("2026-10-18T20:09:00.000Z")).closed).toBe(true); // four minutes after kickoff, status still NOT_STARTED
  });

  it("is closed whenever the Game is no longer NOT_STARTED", () => {
    expect(pickLockState({ ...game, internalStatus: "LIVE" }, 10, new Date("2026-10-18T10:00:00.000Z")).closed).toBe(true);
  });

  it("follows the configured minutes (the setting, not a constant)", () => {
    expect(pickLockState(game, 5, new Date("2026-10-18T19:57:00.000Z")).closed).toBe(false);
    expect(pickLockState(game, 5, new Date("2026-10-18T20:00:00.000Z")).closed).toBe(true);
  });
});
