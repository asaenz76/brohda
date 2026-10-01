/**
 * Protects against a real PostgREST failure mode: a large enough .in(column,
 * ids) list hits PostgREST's URL-length ceiling and fails with a bare "URI
 * too long". fetchInChunks fixes this by splitting large id lists into
 * safely-sized batches. This test proves both halves against the real local
 * Postgres/PostgREST stack: a single oversized .in() really does fail, and
 * the same list chunked via fetchInChunks does not.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { describe, expect, it } from "vitest";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { fetchInChunks } from "@/lib/utils/batch";

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
    const { error } = await admin.from("fixtures").select("id").in("id", fakeIds(600));
    expect(error).not.toBeNull();
  });

  it("fetchInChunks handles the same 600-id list without error, by splitting it into safe batches", async () => {
    const rows = await fetchInChunks(fakeIds(600), (chunk) =>
      admin.from("fixtures").select("id").in("id", chunk),
    );
    // None of the fake ids match a real fixture — the point is that no
    // request errors, not that any rows come back.
    expect(rows).toEqual([]);
  });
});
