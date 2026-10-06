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

// PostgREST silently truncates any single response at the project's `max_rows` (1000 by default) — no error, no flag, just fewer rows.
// A whole-table integrity read must therefore page. The page size stays well under that ceiling so a short page reliably means "the end",
// and callers must order by a unique column so pages never overlap or skip.
const FULL_READ_PAGE_SIZE = 500;

export async function fetchAllRows<Row>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += FULL_READ_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + FULL_READ_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < FULL_READ_PAGE_SIZE) return rows;
  }
}
