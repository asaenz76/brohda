import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExecutionKillSwitch, KillSwitchScope } from "./types";

// Milestone 5.5 — repository + pure precedence logic for
// execution_kill_switches (migration 20260101000153). Deny-by-default,
// service-role-only table (no authenticated policy at all) — every read
// and write here goes through the admin client, authorized upstream by
// lib/execution/authorization.ts's capability guards, never by RLS alone.

interface KillSwitchRow {
  id: string;
  scope: KillSwitchScope;
  target: string | null;
  enabled: boolean;
  reason: string;
  note: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  disabled_by: string | null;
  disabled_at: string | null;
}

function toDomain(row: KillSwitchRow): ExecutionKillSwitch {
  return {
    id: row.id,
    scope: row.scope,
    target: row.target,
    enabled: row.enabled,
    reason: row.reason,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    disabledBy: row.disabled_by,
    disabledAt: row.disabled_at,
  };
}

/**
 * Every currently-enabled switch, regardless of scope/target/expiry — the
 * full filtering (does this row's scope/target genuinely apply to this
 * request, has it expired) happens in application code
 * (lib/execution/control-plane.ts's `switchGenuinelyMatches`), not in a
 * hand-built PostgREST OR-filter string. Kill switches are expected to be
 * a small operational table (tens, not millions, of rows), so fetching
 * every enabled row and filtering in memory is simpler and more
 * obviously correct than a fragile, string-interpolated multi-scope query
 * — a lesson learned directly from this feature's own E2E verification,
 * where an earlier, cleverer query silently matched nothing.
 */
export async function listActiveKillSwitches(): Promise<ExecutionKillSwitch[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_kill_switches")
    .select("*")
    .eq("enabled", true)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as KillSwitchRow[]).map(toDomain);
}

export async function listAllKillSwitches(limit = 200): Promise<ExecutionKillSwitch[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("execution_kill_switches").select("*").order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as KillSwitchRow[]).map(toDomain);
}

export interface CreateKillSwitchInput {
  scope: KillSwitchScope;
  target: string | null;
  reason: string;
  note: string | null;
  createdBy: string;
  expiresAt: string | null;
}

export async function createKillSwitch(input: CreateKillSwitchInput): Promise<ExecutionKillSwitch> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_kill_switches")
    .insert({
      scope: input.scope,
      target: input.target,
      reason: input.reason,
      note: input.note,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toDomain(data as KillSwitchRow);
}

/** Soft-disable — the row is never deleted, preserving history (STEP 29). */
export async function disableKillSwitch(id: string, disabledBy: string): Promise<ExecutionKillSwitch | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("execution_kill_switches")
    .update({ enabled: false, disabled_by: disabledBy, disabled_at: new Date().toISOString() })
    .eq("id", id)
    .eq("enabled", true)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toDomain(data as KillSwitchRow) : null;
}

/**
 * Deterministic precedence — broadest to narrowest — over whatever active
 * switches are actually found. Documented, not the task's example order
 * blindly copied: GLOBAL is checked first because it is definitionally the
 * broadest, cheapest-to-explain block; PROVIDER/JURISDICTION/USER/MARKET/
 * COHORT follow in decreasing "how much of the platform this affects"
 * order, which is also the most useful order for an operator reading a
 * denial reason (the most significant reason a request was blocked, not an
 * arbitrary one among several that happened to match).
 */
const SCOPE_PRECEDENCE: readonly KillSwitchScope[] = ["GLOBAL", "PROVIDER", "JURISDICTION", "USER", "MARKET", "COHORT"];

export function pickHighestPrecedenceSwitch(switches: ExecutionKillSwitch[]): ExecutionKillSwitch | null {
  for (const scope of SCOPE_PRECEDENCE) {
    const match = switches.find((s) => s.scope === scope);
    if (match) return match;
  }
  return null;
}
