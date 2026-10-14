// Message text normalisation, client-safe. The DATABASE is the authority (messaging_normalize_text in migration 198 does the same); this mirror only lets the composer show the real remaining
// length and refuse an empty message before a round trip. Text is always rendered as text — never as HTML — and links in message text are not made clickable.

/** NFC-normalise, remove control characters (keeping newline), collapse runs of blank lines, trim whitespace. */
export function normalizeMessageText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s ]+|[\s ]+$/g, "");
}

export function remainingCharacters(input: string, max: number): number {
  return max - normalizeMessageText(input).length;
}
