// Supabase's PostgREST URL-encodes every id in an `.in()` filter into the
// request URL itself — a few hundred UUIDs comfortably blows past common
// proxy/CDN URL-length ceilings, and the response is empty rather than
// erroring loudly. Splitting large id lists into safe-sized batches
// sidesteps the URL-length ceiling entirely, at the cost of one extra round
// trip per ~150 ids.
const IN_CLAUSE_CHUNK_SIZE = 150;

export async function fetchInChunks<Row>(
  ids: string[],
  fetchChunk: (chunk: string[]) => PromiseLike<{ data: Row[] | null }>,
): Promise<Row[]> {
  if (ids.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + IN_CLAUSE_CHUNK_SIZE));
  }
  const results = await Promise.all(chunks.map(fetchChunk));
  return results.flatMap((r) => r.data ?? []);
}
