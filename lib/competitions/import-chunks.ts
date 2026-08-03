import type { NormalizedFixture } from "@/lib/sports-data/types";
import { IMPORT_CHUNK_MAX_BYTES, IMPORT_CHUNK_MAX_FIXTURES } from "./constants";

/**
 * Splits a season's fixtures into chunks for competition_import_job_chunks,
 * greedily filling each chunk until either bound is hit — count first
 * (cheap to check), byte size second (the real backstop, since a
 * NormalizedFixture embeds its entire raw provider payload and per-fixture
 * size isn't predictable from count alone). A single oversized fixture
 * still gets its own chunk rather than being dropped.
 */
export function buildImportChunks(fixtures: NormalizedFixture[]): NormalizedFixture[][] {
  const chunks: NormalizedFixture[][] = [];
  let current: NormalizedFixture[] = [];
  let currentBytes = 0;

  for (const fixture of fixtures) {
    const fixtureBytes = Buffer.byteLength(JSON.stringify(fixture), "utf8");
    const wouldExceedCount = current.length >= IMPORT_CHUNK_MAX_FIXTURES;
    const wouldExceedBytes = current.length > 0 && currentBytes + fixtureBytes > IMPORT_CHUNK_MAX_BYTES;

    if (wouldExceedCount || wouldExceedBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(fixture);
    currentBytes += fixtureBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Serialized byte size of one chunk's payload — stored on the chunk row
 * for observability (payload_bytes), independent of what triggered the
 * chunk boundary. */
export function chunkPayloadBytes(fixtures: NormalizedFixture[]): number {
  return Buffer.byteLength(JSON.stringify(fixtures), "utf8");
}
