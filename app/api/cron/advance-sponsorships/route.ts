import { NextResponse } from "next/server";
import { recordJobRun } from "@/lib/jobs/record";
import { isSponsorshipEnabled } from "@/lib/sponsorship/capability";
import { callSponsorshipFunction } from "@/lib/sponsorship/repository";

// SCHEDULED -> LIVE, LIVE/SCHEDULED -> COMPLETED, and release of expired unpaid holds. Housekeeping only: it moves sponsorships that are ALREADY paid and
// approved along the clock (the database CHECK makes anything else impossible), never approves, prices, or marks anything paid, and never touches the
// canonical Game / Post / Market / Pick. Public rendering independently re-verifies every condition on each read, so a missed run can delay a stored label
// but can never show (or hide) a sponsorship wrongly.
//
// It respects the capability: with Sponsored Game Posts OFF (or unreadable) the run is a healthy no-op — `policyEnabled: false`, the same convention the other
// flag-gated jobs use, so Job Health reads "feature disabled" rather than failing — and no stored sponsorship changes state while the switch is off. When it
// is switched back on, the next run completes whatever expired in the meantime; rendering never revives an expired campaign.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await recordJobRun("advance-sponsorships", async () => {
    const ranAt = new Date().toISOString();
    if (!(await isSponsorshipEnabled())) return { ranAt, policyEnabled: false, wentLive: 0, completed: 0, reservationsReleased: 0 };
    const advanced = await callSponsorshipFunction("advance_sponsorships", { p_now: ranAt });
    return { policyEnabled: true, ...advanced };
  });
  return NextResponse.json(result);
}
