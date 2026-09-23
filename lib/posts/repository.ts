import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Post } from "./types";

// Milestone R3 — the sole query surface for `posts`, matching this
// codebase's established convention (lib/prediction-markets/repository.ts's
// own header comment: one repository module owns a table's shape so every
// future caller reads the same normalized record, never an ad hoc query).

interface PostRow {
  id: string;
  fixture_id: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: PostRow): Post {
  return { id: row.id, fixtureId: row.fixture_id, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

export type EnsurePostOutcome = "created" | "existing";

/**
 * Idempotent get-or-create (§34) — the canonical Post-creation entry
 * point, and the ONLY place that inserts into `posts`. Concurrency-safe:
 * the DB's own `posts_one_per_fixture` unique constraint is the real
 * guarantee; this function's try-insert/catch-23505/select-existing shape
 * (the same idiom `create_pool_entry`'s own migration comment documents
 * for exactly this situation) just makes the guarantee idempotent at the
 * application layer instead of surfacing a raw constraint violation.
 */
export async function ensurePostForFixture(fixtureId: string): Promise<{ id: string; outcome: EnsurePostOutcome }> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("posts").insert({ fixture_id: fixtureId }).select("id").single();
  if (!error) return { id: data.id, outcome: "created" };

  if (error.code === "23505") {
    const { data: existing, error: selectError } = await admin.from("posts").select("id").eq("fixture_id", fixtureId).single();
    if (selectError || !existing) throw selectError ?? new Error(`post for fixture ${fixtureId} disappeared after a unique-constraint conflict`);
    return { id: existing.id, outcome: "existing" };
  }

  throw error;
}

/**
 * Publication is a separate step from existence (§8) — idempotent: does
 * nothing if the Post is already published (never resets `published_at`
 * to a later time on a repeated call).
 */
export async function publishPost(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("posts").update({ published_at: new Date().toISOString() }).eq("id", id).is("published_at", null);
  if (error) throw error;
}

export async function getPostByFixtureId(fixtureId: string): Promise<Post | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("posts").select("*").eq("fixture_id", fixtureId).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as PostRow) : null;
}

/** Only ever returns a PUBLISHED Post — the public detail surface's own read, mirroring the RLS policy's own rule explicitly rather than relying on it (this function runs through the admin client, which bypasses RLS). */
export async function getPublishedPostById(id: string): Promise<Post | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("posts").select("*").eq("id", id).not("published_at", "is", null).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as PostRow) : null;
}
