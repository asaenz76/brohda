import "server-only";
import { errorMessage } from "@/lib/utils/error-message";
import { closeFinishedMarkets } from "@/lib/prediction-markets/lifecycle";
import { runGradingJob, type GradingRunSummary } from "./grading";
import type { Prediction, PredictionResult } from "./types";

export interface GradingLifecycleSummary extends GradingRunSummary {
  /** Markets moved ACTIVE -> CLOSED this run (Game finished and every Pick on the Market graded). */
  marketsClosed: number;
}

/**
 * The one grading job (the existing `grade-predictions` cron): grade pending Picks, then close the Markets that are now fully graded on a
 * finished Game. Closing runs AFTER grading so "all Picks graded" is judged on this run's own results, in its own failure domain (a close
 * problem never undoes or blocks grading, and is reported on `failures` so job health reads degraded). Idempotent: nothing left to close
 * means nothing changes.
 */
export async function runGradingLifecycleJob(
  resultRecorder: (prediction: Prediction, result: Extract<PredictionResult, "CORRECT" | "INCORRECT">) => Promise<void>,
): Promise<GradingLifecycleSummary> {
  const grading = await runGradingJob(resultRecorder);
  let marketsClosed = 0;
  const closeFailures: GradingRunSummary["failures"] = [];
  try {
    marketsClosed = (await closeFinishedMarkets()).length;
  } catch (error) {
    closeFailures.push({ predictionId: "(market close sweep)", error: `closing finished Markets failed: ${errorMessage(error)}` });
  }
  return { ...grading, marketsClosed, failures: [...grading.failures, ...closeFailures] };
}
