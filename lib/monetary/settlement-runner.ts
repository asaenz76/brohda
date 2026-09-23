import "server-only";
import { listSettlementEligiblePositionIds, settleMonetaryPosition, getMonetaryPositionById } from "./repository";
import { createSettlementNotifications } from "@/lib/notifications/monetary-settlements";

/**
 * Milestone R13.5 (§16, §24): the canonical settlement-batch runner,
 * extracted from scripts/settle-monetary-positions.ts's own previously
 * inline loop so both that CLI script and app/api/cron/
 * settle-monetary-positions can share the exact same logic — a cron
 * route must never reimplement or duplicate a job's own domain behavior
 * (§16). This function calculates nothing itself: winner, loser, stake,
 * and fee are entirely derived inside settleMonetaryPosition()'s own
 * atomic RPC transaction (R10), never here. This is discovery +
 * dispatch + notification only.
 *
 * Per-Position failure isolation was already correct in the original
 * script (each iteration's own try/catch) — preserved exactly, just
 * moved so it's shared rather than duplicated.
 */
export interface SettlementRunSummary {
  candidates: number;
  settledWin: number;
  settledVoid: number;
  notEligible: number;
  alreadySettled: number;
  invariantViolations: number;
  failures: Array<{ positionId: string; error: string }>;
}

export async function runSettlementJob(limit?: number): Promise<SettlementRunSummary> {
  const positionIds = await listSettlementEligiblePositionIds(limit);
  const summary: SettlementRunSummary = {
    candidates: positionIds.length,
    settledWin: 0,
    settledVoid: 0,
    notEligible: 0,
    alreadySettled: 0,
    invariantViolations: 0,
    failures: [],
  };

  for (const positionId of positionIds) {
    try {
      const result = await settleMonetaryPosition(positionId);

      if (result.outcome === "settled_win" || result.outcome === "settled_void") {
        if (result.outcome === "settled_win") summary.settledWin += 1;
        else summary.settledVoid += 1;
        if (result.settlement) {
          const position = await getMonetaryPositionById(positionId);
          if (position) await createSettlementNotifications(position, result.settlement);
        }
      } else if (result.outcome === "not_eligible") {
        summary.notEligible += 1;
      } else if (result.outcome === "already_settled") {
        summary.alreadySettled += 1;
      } else if (result.outcome === "invariant_violation") {
        // Left COMMITTED, needs manual review (see pnpm check-monetary-consistency) — never auto-repaired.
        summary.invariantViolations += 1;
      }
    } catch (error) {
      summary.failures.push({ positionId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return summary;
}
