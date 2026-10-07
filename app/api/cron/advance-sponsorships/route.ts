import { NextResponse } from "next/server";
import { recordJobRun } from "@/lib/jobs/record";
import { callSponsorshipFunction } from "@/lib/sponsorship/repository";

// SCHEDULED -> LIVE, LIVE/SCHEDULED -> COMPLETED, and release of expired unpaid holds. Housekeeping only: public rendering independently re-verifies every
// condition on each read, so a missed run can delay a status label but can never show (or hide) a sponsorship wrongly.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await recordJobRun("advance-sponsorships", () => callSponsorshipFunction("advance_sponsorships", { p_now: new Date().toISOString() }));
  return NextResponse.json(result);
}
