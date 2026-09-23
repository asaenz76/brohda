import { NextResponse } from "next/server";
import { resolveAcceptedChallenges } from "@/lib/challenges/resolution";
import { recordJobRun } from "@/lib/jobs/record";

// Milestone R13.5: resolves R13's PRODUCTION OPERATIONS DECISION REQUIRED
// finding for Call BS Challenge resolution. Invokes the exact same
// resolveAcceptedChallenges() scripts/resolve-challenges.ts already uses
// — no resolution logic is duplicated here. Must run after grading
// (Challenge resolution consumes predictions.result, which grading
// itself produces) — the scheduler configuration staggers these two
// routes' cadences rather than chaining them synchronously in-process
// (§30: prefer idempotent independent jobs — a Challenge simply stays
// "still pending" here until its own Picks are graded on a later tick,
// which is always safe).
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("resolve-challenges", () => resolveAcceptedChallenges());
  return NextResponse.json(result);
}
