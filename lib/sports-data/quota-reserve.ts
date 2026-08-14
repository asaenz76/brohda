import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER, type FixtureProvider } from "./provider-names";

// Phase 3 spec §18: protect enough quota for high-value manual operations
// (pool creation market lookup, troubleshooting, critical sync) by having
// background jobs stop before consuming the entire daily allowance.
//
// Neither provider exposes a real "requests remaining today" value —
// confirmed during the Phase 3 audit: no response header or body field on
// either API-Football or API-NFL carries this (provider-gateway.ts's own
// long-standing comment on `getProviderStatus` says the same). So this is
// NOT a read of the provider's own quota; it's a self-imposed, opt-in
// ceiling checked against the real count of requests we've actually made
// in the last 24h (provider_request_log — the same durable record the
// circuit breaker already reads). With no budget configured for a
// provider, this never blocks anything: nothing here fabricates a limit
// that was never confirmed, matching spec §17's "do not fabricate reset
// times" in spirit.
const BUDGET_ENV_VAR: Record<FixtureProvider, string> = {
  [API_FOOTBALL_PROVIDER]: "API_FOOTBALL_DAILY_REQUEST_BUDGET",
  [API_NFL_PROVIDER]: "API_NFL_DAILY_REQUEST_BUDGET",
};

const DEFAULT_WARNING_RATIO = 0.7;
const DEFAULT_CRITICAL_RATIO = 0.9;

export type QuotaReserveLevel = "OK" | "WARNING" | "CRITICAL";

export interface QuotaReserveStatus {
  /** False when no budget is configured for this provider — the reserve
   * mechanism is entirely inert in that case. */
  enabled: boolean;
  requestsLast24h: number;
  dailyBudget: number | null;
  warningThreshold: number | null;
  criticalThreshold: number | null;
  level: QuotaReserveLevel;
}

function readBudget(provider: string): number | null {
  const envVar = BUDGET_ENV_VAR[provider as FixtureProvider];
  if (!envVar) return null;
  const raw = process.env[envVar];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function getQuotaReserveStatus(provider: string): Promise<QuotaReserveStatus> {
  const dailyBudget = readBudget(provider);
  if (!dailyBudget) {
    return { enabled: false, requestsLast24h: 0, dailyBudget: null, warningThreshold: null, criticalThreshold: null, level: "OK" };
  }

  const adminClient = createAdminClient();
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await adminClient
    .from("provider_request_log")
    .select("*", { count: "exact", head: true })
    .eq("provider", provider)
    .gte("created_at", since24h);

  const requestsLast24h = count ?? 0;
  const warningThreshold = Math.floor(dailyBudget * DEFAULT_WARNING_RATIO);
  const criticalThreshold = Math.floor(dailyBudget * DEFAULT_CRITICAL_RATIO);

  let level: QuotaReserveLevel = "OK";
  if (requestsLast24h >= criticalThreshold) level = "CRITICAL";
  else if (requestsLast24h >= warningThreshold) level = "WARNING";

  return { enabled: true, requestsLast24h, dailyBudget, warningThreshold, criticalThreshold, level };
}

/** Whether a scheduled/background job should stop BEFORE spending more
 * quota this tick — true only once the self-imposed CRITICAL threshold is
 * reached, and always false when no budget is configured (opt-in, never a
 * silent default cap). Only ever meant to gate scheduled/background work
 * — manual admin actions, pool creation, and troubleshooting lookups are
 * exactly the "high-value" operations this reserve exists to protect, so
 * they must never check this themselves. */
export async function shouldReserveQuota(provider: string): Promise<boolean> {
  const status = await getQuotaReserveStatus(provider);
  return status.level === "CRITICAL";
}
