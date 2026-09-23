import { NextResponse } from "next/server";
import { runGradingJob } from "@/lib/predictions/grading";
import { recordGradedPredictionResult } from "@/lib/predictions/streak";
import { recordJobRun } from "@/lib/jobs/record";

// Milestone R13.5: resolves R13's PRODUCTION OPERATIONS DECISION REQUIRED
// finding for Prediction grading. Invokes the exact same runGradingJob()
// scripts/grade-predictions.ts already uses — no grading logic is
// duplicated here. Batch size is read live from
// platform_settings.grading_batch_size inside listPendingPredictions()
// itself; this route passes no limit.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("grade-predictions", () => runGradingJob(recordGradedPredictionResult));
  return NextResponse.json(result);
}
