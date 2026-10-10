// The unresolved-placeholder detector for Sponsor legal text. An APPROVED document must contain none of these, and CI proves it (tests/unit/sponsor-legal-activation-guard.test.tsx):
// a document can never become legally active by flipping one word while a "[counsel — …]" gap, a "TBD" or a draft marker is still in its text.
//
// Deliberately broad. Any square-bracketed note containing a word (a legal text has no reason to), and any of the marker words below, counts as unresolved.
const BRACKETED_NOTE = /\[[^\]]*[A-Za-z][^\]]*\]/g;
// Single marker words are matched in CAPITALS only (a legal text can say "your own counsel" or "a draft of the creative"); the phrases are matched in any case.
const MARKER_WORDS = /\b(?:TBD|TODO|COUNSEL|PLACEHOLDER|INSERT|DRAFT)\b/g;
const MARKER_PHRASES = /\b(?:owner decision|wording to be provided|to be provided)\b/gi;

/** Every unresolved marker found in `text` (whitespace-normalised), in order of appearance. Empty means the text is clear to activate. */
export function findUnresolvedMarkers(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  const bracketed = flat.match(BRACKETED_NOTE) ?? [];
  const rest = flat.replace(BRACKETED_NOTE, " "); // a bracketed note is reported once, not again for the words inside it
  return [...bracketed, ...(rest.match(MARKER_WORDS) ?? []), ...(rest.match(MARKER_PHRASES) ?? [])];
}
