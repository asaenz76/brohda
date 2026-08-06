// Shared by every cache that decides "use the stored row, or go fetch a new
// one" purely by age — squads.ts, odds.ts, availability-cache.ts each
// reimplemented this same comparison with their own TTL constant.
export function isFresh(fetchedAt: string, ttlMs: number): boolean {
  return Date.now() - new Date(fetchedAt).getTime() < ttlMs;
}
