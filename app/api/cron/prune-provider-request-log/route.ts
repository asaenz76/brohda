import { NextResponse } from "next/server";
import { runProviderRequestLogRetention } from "@/lib/sports-data/provider-request-log-retention";
import { runBackgroundJobsRetention } from "@/lib/jobs/retention";
import { runMessagingRetention } from "@/lib/messaging/retention";
import { recordJobRun } from "@/lib/jobs/record";
import { errorMessage } from "@/lib/utils/error-message";

// The one housekeeping job: it keeps the provider request log AND the cron run history bounded, and applies the Messaging retention policy (a no-op until its own master switch is turned on). Both live behind this single route so no extra
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
    return { ...(providerRequestLog ?? { batchesRun: 0, rowsDeleted: 0 }), backgroundJobs, messaging, failures };
  });
  return NextResponse.json(result);
}
