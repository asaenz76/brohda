import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CohortMode, ExecutionCohort } from "./types";

// Milestone 5.5 — provider-neutral, configuration-driven rollout cohorts
// (migration 20260101000153). STEP 8's own instruction not to overbuild
// experimentation infrastructure: two modes only (ALLOWLIST, PERCENTAGE),
// no A/B-testing framework, no traffic-splitting beyond a single
// deterministic percentage per cohort.

interface CohortRow {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  mode: CohortMode;
  percentage: number | null;
  rollout_seed: string | null;
  provider_scope: string | null;
  jurisdiction_scope: string | null;
  starts_at: string | null;
  ends_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: CohortRow): ExecutionCohort {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    mode: row.mode,
    percentage: row.percentage,
    rolloutSeed: row.rollout_seed,
    providerScope: row.provider_scope,
    jurisdictionScope: row.jurisdiction_scope,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAllCohorts(): Promise<ExecutionCohort[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_cohorts").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return (data as CohortRow[]).map(toDomain);
}

export async function listEnabledCohorts(): Promise<ExecutionCohort[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_cohorts").select("*").eq("enabled", true);
  if (error) throw error;
  return (data as CohortRow[]).map(toDomain);
}

export interface CreateCohortInput {
  key: string;
  name: string;
  mode: CohortMode;
  percentage: number | null;
  rolloutSeed: string | null;
  providerScope: string | null;
  jurisdictionScope: string | null;
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
}

export async function createCohort(input: CreateCohortInput): Promise<ExecutionCohort> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_cohorts")
    .insert({
      key: input.key,
      name: input.name,
      mode: input.mode,
      percentage: input.percentage,
      rollout_seed: input.rolloutSeed,
      provider_scope: input.providerScope,
      jurisdiction_scope: input.jurisdictionScope,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toDomain(data as CohortRow);
}

export async function setCohortEnabled(id: string, enabled: boolean): Promise<ExecutionCohort | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_cohorts").update({ enabled }).eq("id", id).select("*").maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as CohortRow) : null;
}

export async function addCohortMember(cohortId: string, userId: string, addedBy: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("execution_cohort_members").upsert({ cohort_id: cohortId, user_id: userId, added_by: addedBy }, { onConflict: "cohort_id,user_id" });
  if (error) throw error;
}

export async function removeCohortMember(cohortId: string, userId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("execution_cohort_members").delete().eq("cohort_id", cohortId).eq("user_id", userId);
  if (error) throw error;
}

export async function isExplicitMember(cohortId: string, userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_cohort_members").select("user_id").eq("cohort_id", cohortId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Deterministic percentage assignment (STEP 9) — never randomized per
 * request. The same (seed, userId) pair always hashes to the same bucket,
 * so a user never oscillates between "in" and "out" across requests, and
 * changing only the configured `percentage` (not the seed) changes exactly
 * which users are newly included/excluded, without reshuffling everyone
 * who was already assigned — a property plain `Math.random() < p` could
 * never offer.
 *
 * Uses the Web Crypto SHA-256 digest of `${seed}:${userId}`, taking the
 * first 4 bytes as an unsigned integer and reducing mod 100 — a
 * cryptographic hash was already available via the platform's `crypto`
 * global (no new dependency), and its avalanche property is more than
 * sufficient for a rollout bucket (this is not a security boundary).
 */
export async function hashToPercentageBucket(seed: string, userId: string): Promise<number> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${seed}:${userId}`));
  const bytes = new Uint8Array(digest);
  const value = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return Math.abs(value) % 100;
}

export async function evaluateCohortMembership(cohort: ExecutionCohort, userId: string, now: Date): Promise<boolean> {
  if (!cohort.enabled) return false;
  if (cohort.startsAt && now.getTime() < new Date(cohort.startsAt).getTime()) return false;
  if (cohort.endsAt && now.getTime() >= new Date(cohort.endsAt).getTime()) return false;

  if (cohort.mode === "ALLOWLIST") return isExplicitMember(cohort.id, userId);

  // PERCENTAGE
  const bucket = await hashToPercentageBucket(cohort.rolloutSeed!, userId);
  return bucket < (cohort.percentage ?? 0);
}

/** Every enabled cohort key a user currently belongs to — used by the kill-switch COHORT scope and the rollout-mode gate. */
export async function getUserCohortKeys(userId: string, now: Date = new Date()): Promise<string[]> {
  const cohorts = await listEnabledCohorts();
  const keys: string[] = [];
  for (const cohort of cohorts) {
    if (await evaluateCohortMembership(cohort, userId, now)) keys.push(cohort.key);
  }
  return keys;
}
