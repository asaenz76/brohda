import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { listSettlementEligiblePositionIds, settleMonetaryPosition, getMonetaryPositionById, expireStaleMonetaryProposals } from "./repository";
import { createSettlementNotifications } from "@/lib/notifications/monetary-settlements";
import { createMonetaryProposalExpiredNotification } from "@/lib/notifications/monetary-proposals";
import { deliverNotification } from "@/lib/notifications/deliver";

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
  /** PENDING proposals expired this run (Game past cutoff) — each had its proposer's reservation released. */
  expiredProposals: number;
  failures: Array<{ positionId?: string; proposalId?: string; error: string }>;
}

export async function runSettlementJob(limit?: number): Promise<SettlementRunSummary> {
  // Expire stale PENDING proposals first, in their own failure domain: a
  // sweep problem must never block settling money that is already owed, and
  // a settlement problem must never leave proposers' funds on hold. Rides on
  // this job (already scheduled every couple of minutes) rather than adding
  // a second scheduler entry.
  const expiryFailures: SettlementRunSummary["failures"] = [];
  let expiredProposals = 0;
  try {
    const expired = await expireStaleMonetaryProposals();
    expiredProposals = expired.length;
    for (const proposal of expired) {
      const delivery = await deliverNotification("monetary", "MONETARY_PROPOSAL_EXPIRED", `proposal ${proposal.id}`, () => createMonetaryProposalExpiredNotification(proposal));
      if (!delivery.delivered) expiryFailures.push({ proposalId: proposal.id, error: `expired and released, but MONETARY_PROPOSAL_EXPIRED notification failed: ${delivery.error}` });
    }
  } catch (error) {
    expiryFailures.push({ error: `proposal expiry sweep failed: ${errorMessage(error)}` });
  }

  const positionIds = await listSettlementEligiblePositionIds(limit);
  const summary: SettlementRunSummary = {
    candidates: positionIds.length,
    settledWin: 0,
    settledVoid: 0,
    notEligible: 0,
    alreadySettled: 0,
    invariantViolations: 0,
    expiredProposals,
    failures: [...expiryFailures],
  };

  for (const positionId of positionIds) {
    try {
      const result = await settleMonetaryPosition(positionId);

      if (result.outcome === "settled_win" || result.outcome === "settled_void") {
        if (result.outcome === "settled_win") summary.settledWin += 1;
        else summary.settledVoid += 1;
        if (result.settlement) {
          const position = await getMonetaryPositionById(positionId);
          if (position) {
            // The settlement is already committed (and can't be re-run), so a
            // delivery failure is recorded — job health reads "degraded" —
            // rather than thrown past the counters above.
            const delivery = await deliverNotification("monetary", "settlement", `position ${positionId}`, () => createSettlementNotifications(position, result.settlement!));
            if (!delivery.delivered) summary.failures.push({ positionId, error: `settled, but settlement notification failed: ${delivery.error}` });
          }
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
      summary.failures.push({ positionId, error: errorMessage(error) });
    }
  }

  return summary;
}
