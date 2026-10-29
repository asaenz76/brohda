import { NextResponse } from "next/server";
import { runProviderRequestLogRetention } from "@/lib/sports-data/provider-request-log-retention";
import { runBackgroundJobsRetention } from "@/lib/jobs/retention";
import { runMessagingRetention } from "@/lib/messaging/retention";
import { runConfidenceBootstrap } from "@/lib/confidence/bootstrap";
import { runConfidenceSettlementSweep } from "@/lib/confidence/settlement";
import { runGamePreviewHousekeeping } from "@/lib/game-previews/housekeeping";
import { runRateLimitRetention } from "@/lib/rate-limit/retention";
import { recordJobRun } from "@/lib/jobs/record";
import { errorMessage } from "@/lib/utils/error-message";

// The one housekeeping job: it keeps the provider request log AND the cron run history bounded, applies the Messaging retention policy (a no-op until its own master switch is turned on) and bootstraps Confidence accounts for existing Members (a no-op while Confidence is OFF) and sweeps any Confidence stake whose Pick is graded but unsettled (normally none), and freezes the pregame Game Preview of every Game that has started (reporting which upcoming Games still need one). Both live behind this single route so no extra
// external scheduler entry is needed. Each has its own failure domain — a problem pruning one never skips the other, and is reported on `failures`
// so Job Health reads it as degraded rather than a silent success.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("prune-provider-request-log", async () => {
    const failures: Array<{ step: string; error: string }> = [];
    const providerRequestLog = await runProviderRequestLogRetention().catch((error) => {
      failures.push({ step: "provider_request_log", error: errorMessage(error) });
      return null;
    });
    const backgroundJobs = await runBackgroundJobsRetention().catch((error) => {
      failures.push({ step: "background_jobs", error: errorMessage(error) });
      return null;
    });
    const messaging = await runMessagingRetention().catch((error) => {
      failures.push({ step: "messaging_retention", error: errorMessage(error) });
      return null;
    });
    const confidence = await runConfidenceBootstrap().catch((error) => {
      failures.push({ step: "confidence_bootstrap", error: errorMessage(error) });
      return null;
    });
    const confidenceSettlement = await runConfidenceSettlementSweep().catch((error) => {
      failures.push({ step: "confidence_settlement", error: errorMessage(error) });
      return null;
    });
    const gamePreviews = await runGamePreviewHousekeeping().catch((error) => {
      failures.push({ step: "game_previews", error: errorMessage(error) });
      return null;
    });
    const rateLimits = await runRateLimitRetention().catch((error) => {
      failures.push({ step: "rate_limits", error: errorMessage(error) });
      return null;
    });
    // Preview GENERATION is not part of this every-5-minutes job: it has its own route and scheduler entry (/api/cron/game-previews). Housekeeping only freezes started Games' Previews and reports what still needs one.
    return { ...(providerRequestLog ?? { batchesRun: 0, rowsDeleted: 0 }), backgroundJobs, messaging, confidence, confidenceSettlement, gamePreviews, rateLimits, failures };
  });
  return NextResponse.json(result);
}
