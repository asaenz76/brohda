/**
 * No "server-only" guard here deliberately — this pure helper is imported
 * by both the server-side broadcaster (`lib/realtime/pool-updates.ts`) and
 * the client-side listener (`SocialPoolCard`), so it can't live in the same
 * module as the server-only broadcast logic: Next's bundler pulls in an
 * entire module's top-level imports (including a sibling `server-only`
 * import) for any client component that imports anything from it, even a
 * pure function that never touches the server-only code.
 */
export function poolEntriesChannelName(poolId: string): string {
  return `pool:${poolId}:entries`;
}
