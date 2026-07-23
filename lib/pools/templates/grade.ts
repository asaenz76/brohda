import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRefundNotifications } from "@/lib/notifications/create";
import { getTemplate } from "./registry";
import { parseEvents } from "./event-helpers";
import type { TemplateFixtureScore } from "./types";

export interface TemplateGradedPool {
  id: string;
  template_id: string | null;
  template_config: Record<string, unknown> | null;
}

export interface TemplateFixtureRow {
  internal_status: string;
  home_team_name: string;
  away_team_name: string;
  home_team_external_id: string | null;
  away_team_external_id: string | null;
  regulation_home_score: number | null;
  regulation_away_score: number | null;
  halftime_home_score: number | null;
  halftime_away_score: number | null;
  // Optional — the two callers (settle.ts, checkPoolResultNowAction) both
  // select it, but kept optional here so tests/other callers that never
  // touch an events-dependent template aren't forced to supply it.
  provider_events_payload?: unknown;
}

function toTemplateFixtureScore(row: TemplateFixtureRow): TemplateFixtureScore {
  return {
    homeTeamName: row.home_team_name,
    awayTeamName: row.away_team_name,
    homeTeamExternalId: row.home_team_external_id,
    awayTeamExternalId: row.away_team_external_id,
    regulationHomeScore: row.regulation_home_score,
    regulationAwayScore: row.regulation_away_score,
    halftimeHomeScore: row.halftime_home_score,
    halftimeAwayScore: row.halftime_away_score,
  };
}

export type GradeTemplatePoolOutcome = "pending" | "voided" | "readyForReview" | "failed" | "skipped";

/**
 * The one place fixture status is checked before any template's gradingRule
 * runs — this IS the "centralized fixture-status normalizer" the spec asks
 * for. Every anomaly status (POSTPONED/SUSPENDED/ABANDONED/CANCELLED/
 * AWARDED/UNKNOWN) is already handled upstream by the existing, unmodified
 * anomaly logic (lib/pools/anomaly.ts, invoked from processAwaitingResults/
 * checkPoolResultNowAction before this function is ever called) — so no
 * individual template's gradingRule needs to know about fixture status at
 * all, only about goals/margins/etc. given a COMPLETED fixture.
 *
 * Reuses prepare_pool_settlement_manual (the same RPC CUSTOM/COMBO already
 * use) and mirrors gradeComboLegsAction's exact "pre-stamp the settlement
 * row" pattern (lib/actions/pool-combo.ts) rather than writing new
 * money-movement SQL — a human admin still confirms
 * (confirmTemplateSettlementAction) before any payout.
 */
export async function gradeTemplatePool(
  pool: TemplateGradedPool,
  fixtureRow: TemplateFixtureRow,
): Promise<GradeTemplatePoolOutcome> {
  if (fixtureRow.internal_status !== "COMPLETED") {
    return "pending";
  }

  const template = pool.template_id ? getTemplate(pool.template_id) : null;
  if (!template) {
    return "failed";
  }

  // Missing data must never be treated as zero (spec) — if this template
  // needs FIXTURE_EVENTS and the cache is empty, that's "not fetched yet
  // or the sync job hasn't caught up," not "nothing happened." Bail out
  // to PENDING before the gradingRule ever runs, exactly like a missing
  // regulation score does for Phase 1 templates.
  if (template.requiredDataSources.includes("FIXTURE_EVENTS") && fixtureRow.provider_events_payload == null) {
    return "pending";
  }

  const admin = createAdminClient();
  const fixture = toTemplateFixtureScore(fixtureRow);
  const events = template.requiredDataSources.includes("FIXTURE_EVENTS")
    ? parseEvents(fixtureRow.provider_events_payload)
    : undefined;
  const grading = template.gradingRule({ fixture, events }, pool.template_config ?? {});

  if (grading.result === "PENDING") {
    return "pending";
  }

  if (grading.result === "VOID") {
    // No existing pool_void_reason cleanly means "a template's own domain
    // logic couldn't resolve a valid outcome" — MATCH_STATUS_UNKNOWN is the
    // closest existing fit. Phase 1's pure arithmetic on already-required
    // regulation/halftime scores should never actually reach this once the
    // fixture is COMPLETED; this branch exists for future templates whose
    // gradingRule can genuinely return VOID (e.g. ambiguous event data).
    const voidReason = "MATCH_STATUS_UNKNOWN";
    const { data: voidedPool, error } = await admin.rpc("confirm_pool_refund", {
      p_pool_id: pool.id,
      p_void_reason: voidReason,
      p_idempotency_key: `${pool.id}:template_void:${voidReason}`,
    });
    if (error || !voidedPool) {
      return "failed";
    }
    await createRefundNotifications(
      pool.id,
      voidedPool.status === "CANCELLED" ? "CANCELLED" : "VOIDED",
      voidReason,
    );
    return "voided";
  }

  // grading.result is "YES" or "NO" from here.
  const { data: options } = await admin
    .from("pool_options")
    .select("id, label")
    .eq("pool_id", pool.id);
  const yesOption = options?.find((o) => o.label === "Yes");
  const noOption = options?.find((o) => o.label === "No");
  if (!yesOption || !noOption) {
    return "failed";
  }
  const winningOption = grading.result === "YES" ? yesOption : noOption;

  const { data: settlement, error: prepareError } = await admin.rpc("prepare_pool_settlement_manual", {
    p_pool_id: pool.id,
  });
  if (prepareError || !settlement) {
    return "failed";
  }

  // prepare_pool_settlement_manual is itself idempotent (returns the
  // existing settlement at the pool's current snapshot_version rather than
  // creating a new one), but nothing else here is unless we check for it —
  // a repeated call (e.g. the same pool re-checked before its status left
  // AWAITING_RESULT) would otherwise re-stamp the same values and grow the
  // append-only evidence log with a duplicate row every time.
  const { data: existingEvidence } = await admin
    .from("pool_grading_evidence")
    .select("id")
    .eq("settlement_id", settlement.id)
    .limit(1)
    .maybeSingle();
  if (existingEvidence) {
    return "readyForReview";
  }

  // Cleared on both options first — otherwise re-grading (e.g. via Undo
  // before confirming) would leave a previous winner's flag stuck true
  // alongside the new one, same reasoning as gradeComboLegsAction.
  await admin
    .from("settlements")
    .update({ winning_option_id: winningOption.id, winning_option_reason: "TEMPLATE_GRADED" })
    .eq("id", settlement.id);
  await admin.from("pool_options").update({ is_winning_option: false }).eq("pool_id", pool.id);
  await admin.from("pool_options").update({ is_winning_option: true }).eq("id", winningOption.id);

  await admin.from("pool_grading_evidence").insert({
    pool_id: pool.id,
    settlement_id: settlement.id,
    template_id: template.id,
    result: grading.result,
    reason: grading.reason,
    evidence: grading.evidence,
  });

  return "readyForReview";
}
