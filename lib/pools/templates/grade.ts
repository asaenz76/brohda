import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRefundNotifications, createSettlementNotifications } from "@/lib/notifications/create";
import { getTemplate, getTemplateConfigSchema } from "./registry";
import { parseEvents } from "./event-helpers";
import type { TemplateFixtureScore } from "./types";

export interface TemplateGradedPool {
  id: string;
  template_id: string | null;
  template_config: Record<string, unknown> | null;
  // Null/absent for any pool created before template versioning shipped —
  // resolved as version 1 (the only version that existed at the time).
  template_version?: number | null;
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

export type GradeTemplatePoolOutcome =
  | "pending"
  | "voided"
  | "settled"
  | "readyForReview"
  | "failed"
  | "skipped"
  | "manualReview";

// Routes a pool to MANUAL_REVIEW instead of a hard failure — funds stay
// exactly where they are (no refund, no payout), the pool stops appearing
// in any automatic settlement pass (both callers only ever select
// AWAITING_RESULT pools), and an admin sees the stored reason on the pool
// detail page. The `.eq("status", "AWAITING_RESULT")` guard makes a repeat
// call a no-op once this has already fired once.
async function routeToManualReview(
  poolId: string,
  reason: "TEMPLATE_VERSION_UNRESOLVABLE" | "TEMPLATE_CONFIG_INVALID" | "BINARY_OPTIONS_UNRESOLVABLE",
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("pools")
    .update({ status: "MANUAL_REVIEW", review_reason: reason })
    .eq("id", poolId)
    .eq("status", "AWAITING_RESULT");
}

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
 * money-movement SQL. Once a winning option is resolved, settlement
 * completes automatically (confirm_pool_settlement, p_admin_id: null) —
 * this is the whole point of the automatic grading pipeline: a normal,
 * unambiguous outcome moves money with no human step. READY_FOR_REVIEW is
 * now reached only when that automatic confirm itself can't safely
 * proceed (a stale snapshot, a no-or-all-winner edge case on a pool
 * created before the one-sided-pool lock-time guard existed, or any other
 * settlement validation failure) — the settlement proposal is already
 * saved either way, so a human can always pick up from exactly where
 * automatic settlement left off via confirmTemplateSettlementAction.
 */
export async function gradeTemplatePool(
  pool: TemplateGradedPool,
  fixtureRow: TemplateFixtureRow,
): Promise<GradeTemplatePoolOutcome> {
  if (fixtureRow.internal_status !== "COMPLETED") {
    return "pending";
  }

  // Exact-version resolution — never falls forward to a newer version, so a
  // template's later replacement never changes how an already-created pool
  // grades. A pool created before versioning shipped has no stored
  // template_version; version 1 is the only version that existed then.
  const resolvedVersion = pool.template_version ?? 1;
  const template = pool.template_id ? getTemplate(pool.template_id, resolvedVersion) : null;
  if (!template) {
    await routeToManualReview(pool.id, "TEMPLATE_VERSION_UNRESOLVABLE");
    return "manualReview";
  }

  // Defensive re-validation against the resolved version's own schema —
  // should never fail for a config that was valid at creation time (an
  // existing version's schema never changes retroactively), but guards
  // against a corrupted or manually-edited stored config routing to review
  // instead of grading against unvalidated data.
  const configSchema = getTemplateConfigSchema(template.id, template.version);
  if (!configSchema) {
    await routeToManualReview(pool.id, "TEMPLATE_CONFIG_INVALID");
    return "manualReview";
  }
  const configParsed = configSchema.safeParse(pool.template_config ?? {});
  if (!configParsed.success) {
    await routeToManualReview(pool.id, "TEMPLATE_CONFIG_INVALID");
    return "manualReview";
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
  const grading = template.gradingRule({ fixture, events }, configParsed.data as Record<string, unknown>);

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

  // grading.result is "YES" or "NO" from here. binary_outcome is the
  // primary lookup now; label matching is kept only as a fallback for rows
  // that predate the binary_outcome backfill (see its migration's
  // structurally-conservative scoping — a pool with any option shape
  // besides exactly {one 'Yes', one 'No'} is never backfilled).
  const { data: options } = await admin
    .from("pool_options")
    .select("id, label, binary_outcome")
    .eq("pool_id", pool.id);
  const yesOption = options?.find((o) => o.binary_outcome === "YES") ?? options?.find((o) => o.label === "Yes");
  const noOption = options?.find((o) => o.binary_outcome === "NO") ?? options?.find((o) => o.label === "No");
  if (!yesOption || !noOption || yesOption.id === noOption.id) {
    await routeToManualReview(pool.id, "BINARY_OPTIONS_UNRESOLVABLE");
    return "manualReview";
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
    template_version: template.version,
    result: grading.result,
    reason: grading.reason,
    evidence: grading.evidence,
  });

  // The point of the automatic grading pipeline: a normal, unambiguous
  // outcome settles immediately, with no admin step. p_admin_id: null
  // marks this as a system-triggered confirm — see confirm_pool_settlement's
  // relaxed auth check (20260101000102) — using a deterministic
  // idempotency key (not crypto.randomUUID() the way the admin-UI confirm
  // button does) so a retried cron tick converges on the same wallet
  // transactions instead of minting a fresh key every attempt.
  const { error: confirmError } = await admin.rpc("confirm_pool_settlement", {
    p_pool_id: pool.id,
    p_admin_id: null,
    p_grading_version: settlement.grading_version,
    p_idempotency_key: `${pool.id}:auto_settle:${settlement.grading_version}`,
    p_winning_option_id: winningOption.id,
  });

  if (confirmError) {
    // Automatic settlement couldn't safely complete — a stale snapshot, a
    // no-or-all-winner edge case on a pool created before the
    // one-sided-pool lock-time guard existed, or any other validation
    // failure inside the RPC. The settlement proposal above is already
    // saved; fall back to the pre-existing manual-review flow rather than
    // erroring out — READY_FOR_REVIEW exists for exactly this case now.
    return "readyForReview";
  }

  await createSettlementNotifications(pool.id);
  return "settled";
}
