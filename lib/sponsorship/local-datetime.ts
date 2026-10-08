// Campaign windows are stored as instants (UTC). The admin edits them in THEIR OWN time zone — the same one every kickoff and timestamp in the app is
// shown in — so "kickoff 11:00 AM" and "ends 5:00 PM" (kickoff + 6h) read consistently. (Showing the window in UTC beside a local-time kickoff made a correct
// default look hours off.) These two functions are the only conversion between a stored instant and a <input type="datetime-local"> value.
const pad = (n: number) => String(n).padStart(2, "0");

/** An instant → the viewer-local `YYYY-MM-DDTHH:mm` a datetime-local input expects ("" when invalid). */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A viewer-local datetime-local value → the instant it means (ISO, UTC); null when empty or invalid. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value); // a date-time string WITHOUT an offset is parsed as local time
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The viewer's IANA time zone, for labelling ("America/Costa_Rica"); empty when unknown. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
