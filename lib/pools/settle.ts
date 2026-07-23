import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  hasCalendarDayEnded,
  isAnomalyStatus,
  mapAnomalyToVoidReason,
  requiresSameDayWait,
} from "@/lib/pools/anomaly";
import { createRefundNotifications } from "@/lib/notifications/create";
import { gradeTemplatePool } from "@/lib/pools/templates/grade";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

export interface ProcessResultsResult {
  checked: number;
  preparedForReview: number;
  voided: number;
  waiting: number;
  failed: number;
  /** CUSTOM pools — no fixture by design, waiting on a super_admin to Grade
   *  Manually. Counted separately so job-health reporting doesn't read a
   *  pool that can never resolve through this path as a failure. */
  skipped: number;
}

function unwrapEmbed<T>(raw: unknown): T | null {
  return (Array.isArray(raw) ? raw[0] : raw) as T | null;
}

/**
 * `process-results` cron body: AWAITING_RESULT -> READY_FOR_REVIEW | VOIDED.
 * Separate from lib/pools/lock.ts's job because this step depends on
 * fixture-sync data catching up (Phase 3's sync job), not a clock. Anomaly
 * handling (X.7) and normal settlement prep (§16) share this one pass since
 * both start from "what does the fixture's current status say."
 */
export async function processAwaitingResults(): Promise<ProcessResultsResult> {
  const admin = createAdminClient();
  const result: ProcessResultsResult = {
    checked: 0,
    preparedForReview: 0,
    voided: 0,
    waiting: 0,
    failed: 0,
    skipped: 0,
  };

  const { data: pools } = await admin
    .from("pools")
    .select(
      "id, pool_type, template_id, template_config, fixtures(internal_status, scheduled_start_utc, venue_timezone, home_team_name, away_team_name, home_team_external_id, away_team_external_id, regulation_home_score, regulation_away_score, halftime_home_score, halftime_away_score, provider_events_payload)",
    )
    .eq("status", "AWAITING_RESULT");

  for (const pool of pools ?? []) {
    result.checked++;

    const fixture = unwrapEmbed<{
      internal_status: string;
      scheduled_start_utc: string;
      venue_timezone: string | null;
      home_team_name: string;
      away_team_name: string;
      home_team_external_id: string | null;
      away_team_external_id: string | null;
      regulation_home_score: number | null;
      regulation_away_score: number | null;
      halftime_home_score: number | null;
      halftime_away_score: number | null;
      provider_events_payload: unknown;
    }>(pool.fixtures);

    if (!fixture) {
      if (pool.pool_type === "CUSTOM") {
        result.skipped++;
      } else {
        result.failed++;
      }
      continue;
    }

    const internalStatus = fixture.internal_status as FixtureInternalStatus;

    if (isAnomalyStatus(internalStatus)) {
      const timezone = fixture.venue_timezone || process.env.DEFAULT_TIMEZONE || "America/Costa_Rica";

      if (
        requiresSameDayWait(internalStatus) &&
        !hasCalendarDayEnded(fixture.scheduled_start_utc, timezone)
      ) {
        result.waiting++;
        continue;
      }

      const voidReason = mapAnomalyToVoidReason(internalStatus);
      const { data: voidedPool, error } = await admin.rpc("confirm_pool_refund", {
        p_pool_id: pool.id,
        p_void_reason: voidReason,
        p_idempotency_key: `${pool.id}:void:${voidReason}`,
      });

      if (error || !voidedPool) {
        result.failed++;
        continue;
      }

      await createRefundNotifications(
        pool.id,
        voidedPool.status === "CANCELLED" ? "CANCELLED" : "VOIDED",
        voidReason,
      );
      result.voided++;
      continue;
    }

    if (internalStatus === "COMPLETED") {
      if (pool.pool_type === "TEMPLATE_GRADED") {
        const outcome = await gradeTemplatePool(pool, fixture);
        if (outcome === "readyForReview") {
          result.preparedForReview++;
        } else if (outcome === "voided") {
          result.voided++;
        } else if (outcome === "pending") {
          result.waiting++;
        } else {
          result.failed++;
        }
        continue;
      }

      const { error } = await admin.rpc("prepare_pool_settlement", { p_pool_id: pool.id });
      if (error) {
        result.failed++;
      } else {
        result.preparedForReview++;
      }
      continue;
    }

    // NOT_STARTED/LIVE/HALFTIME/EXTRA_TIME/PENALTIES — still in progress.
    result.waiting++;
  }

  return result;
}
