import { afterEach, describe, expect, it } from "vitest";
import { isoToLocalInput, localInputToIso } from "@/lib/sponsorship/local-datetime";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
const inZone = <T,>(tz: string, fn: () => T): T => {
  process.env.TZ = tz;
  return fn();
};

describe("campaign window ↔ the admin's own time zone", () => {
  // The reported case: an NFL kickoff of 11:00 AM in Costa Rica (UTC-6) is 17:00 UTC; the default end is kickoff + 6h = 5:00 PM LOCAL, which is 23:00 UTC.
  it("kickoff 11:00 AM Costa Rica + 6h ends 5:00 PM Costa Rica — not '11:00 PM' (that was the UTC value shown beside a local kickoff)", () => {
    const kickoff = new Date("2026-10-11T17:00:00Z");
    const end = new Date(kickoff.getTime() + 6 * 3_600_000).toISOString();
    expect(inZone("America/Costa_Rica", () => isoToLocalInput(kickoff.toISOString()))).toBe("2026-10-11T11:00");
    expect(inZone("America/Costa_Rica", () => isoToLocalInput(end))).toBe("2026-10-11T17:00");
  });

  it("crossing midnight stays consistent: a 2:05 PM Costa Rica kickoff ends 8:05 PM the same local day", () => {
    const end = new Date(new Date("2026-10-11T20:05:00Z").getTime() + 6 * 3_600_000).toISOString(); // 02:05 UTC next day
    expect(inZone("UTC", () => isoToLocalInput(end))).toBe("2026-10-12T02:05");
    expect(inZone("America/Costa_Rica", () => isoToLocalInput(end))).toBe("2026-10-11T20:05");
  });

  it.each(["UTC", "America/Costa_Rica", "America/New_York", "Europe/Madrid", "Asia/Tokyo", "Asia/Kolkata", "Pacific/Auckland"])("round-trips an instant exactly in %s", (tz) => {
    for (const iso of ["2026-10-11T17:00:00.000Z", "2026-03-08T07:30:00.000Z", "2026-11-01T12:15:00.000Z"]) {
      const local = inZone(tz, () => isoToLocalInput(iso));
      expect(inZone(tz, () => localInputToIso(local)), `${tz} ${iso}`).toBe(iso);
    }
  });

  it("a datetime-local value is interpreted in the viewer's zone, never as UTC", () => {
    expect(inZone("America/Costa_Rica", () => localInputToIso("2026-10-11T17:00"))).toBe("2026-10-11T23:00:00.000Z");
    expect(inZone("UTC", () => localInputToIso("2026-10-11T17:00"))).toBe("2026-10-11T17:00:00.000Z");
  });

  it("empty or invalid input is refused rather than guessed", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("not a date")).toBeNull();
    expect(isoToLocalInput("nope")).toBe("");
  });
});
