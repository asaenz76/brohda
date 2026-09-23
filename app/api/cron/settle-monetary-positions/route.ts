import { NextResponse } from "next/server";
import { runSettlementJob } from "@/lib/monetary/settlement-runner";
import { recordJobRun } from "@/lib/jobs/record";

// Milestone R13.5: resolves R13's PRODUCTION OPERATIONS DECISION REQUIRED
// finding for P2P settlement — the most sensitive of the three jobs.
// Invokes runSettlementJob() (lib/monetary/settlement-runner.ts), the
// exact same shared runner scripts/settle-monetary-positions.ts now also
// calls. This route never derives a winner, loser, stake, or fee itself
// — every settlement RPC call goes through the canonical R10
// settleMonetaryPosition(), which is the sole source of financial truth.
// Batch size is read live from platform_settings.settlement_batch_size
// (R12) inside listSettlementEligiblePositionIds() itself; this route
// passes no limit. Settlement is NOT gated by
// platform_settings.monetary_p2p_enabled — that flag only blocks NEW
// proposals/acceptances (R9/R10/R12 semantics, unchanged here);
// already-committed Positions always continue to settle regardless.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("settle-monetary-positions", () => runSettlementJob());
  return NextResponse.json(result);
}
