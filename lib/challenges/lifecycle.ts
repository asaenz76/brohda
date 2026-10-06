import "server-only";
import { errorMessage } from "@/lib/utils/error-message";
import { expireStaleChallenges } from "./repository";
import { resolveAcceptedChallenges, type ChallengeResolutionRunSummary } from "./resolution";

export interface ChallengeLifecycleSummary extends ChallengeResolutionRunSummary {
  /** PENDING Call BS expired this run because they could no longer be accepted. */
  expired: number;
}

/**
 * The one Call BS lifecycle job (the existing `resolve-challenges` cron): first sweep PENDING challenges that can no longer be accepted
 * to EXPIRED, then resolve ACCEPTED challenges whose Picks are graded. The sweep runs in its own failure domain, as the monetary
 * proposal expiry does inside the settlement job: a sweep problem must never block resolution, and a resolution problem must never leave
 * un-acceptable challenges showing as pending. No second scheduler entry. The result keeps the resolver's summary shape (so job health
 * still reads `failures`) and adds `expired`.
 */
export async function runChallengeLifecycleJob(): Promise<ChallengeLifecycleSummary> {
  let expired = 0;
  const sweepFailures: ChallengeResolutionRunSummary["failures"] = [];
  try {
    expired = (await expireStaleChallenges()).length;
  } catch (error) {
    sweepFailures.push({ challengeId: "(expiry sweep)", error: `pending Call BS expiry sweep failed: ${errorMessage(error)}` });
  }
  const resolution = await resolveAcceptedChallenges();
  return { ...resolution, expired, failures: [...sweepFailures, ...resolution.failures] };
}
