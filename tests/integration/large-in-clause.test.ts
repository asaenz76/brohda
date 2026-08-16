/**
 * Protects the root cause behind "the Feed filters aren't working": once a
 * viewer has enough visible pool history (~580+ rows), every .in(column,
 * ids) call in getPoolCardViewModels (lib/pools/fetch.ts) hit PostgREST's
 * URL-length ceiling and failed with a bare "URI too long" — silently
 * swallowed since none of those calls checked their query's error, so
 * every pool got dropped instead of erroring loudly. fetchInChunks fixes
 * this by splitting large id lists into safely-sized batches. This test
 * proves both halves against the real local Postgres/PostgREST stack: a
 * single oversized .in() really does fail, and the same list chunked via
 * fetchInChunks does not.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { describe, expect, it } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { fetchInChunks } from "@/lib/pools/fetch";

const { serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

// Doesn't need to match real rows — proving the request itself fails/
// succeeds only depends on the URL length, not on any of these ids
// resolving to actual pools.
function fakeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
}

describe.skipIf(!SERVICE_ROLE_KEY)("large .in() clause handling", () => {
  it("a single .in() call with 600 ids fails with a URI-too-long error (confirms the root cause is real)", async () => {
    const { error } = await admin.from("pools").select("id").in("id", fakeIds(600));
    expect(error).not.toBeNull();
  });

  it("fetchInChunks handles the same 600-id list without error, by splitting it into safe batches", async () => {
    const rows = await fetchInChunks(fakeIds(600), (chunk) =>
      admin.from("pools").select("id").in("id", chunk),
    );
    // None of the fake ids match a real pool — the point is that no
    // request errors, not that any rows come back.
    expect(rows).toEqual([]);
  });
});
