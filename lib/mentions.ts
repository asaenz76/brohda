// Shared between the server (parsing a posted comment for notifications)
// and the client (linkifying rendered comment text) — no "server-only"
// import here. Requires the same 3-24 lowercase/digit/underscore shape as
// updateProfileSchema's username regex, since only a real handle can ever
// resolve to a profile. The negative lookbehind keeps "user@domain.com"
// from being misread as a mention of "domain".
export const MENTION_REGEX = /(?<![\w.])@([a-z0-9_]{3,24})\b/gi;

export function extractMentionedUsernames(body: string): string[] {
  const usernames = new Set<string>();
  for (const match of body.matchAll(MENTION_REGEX)) {
    usernames.add(match[1].toLowerCase());
  }
  return [...usernames];
}
