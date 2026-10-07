import { NextResponse } from "next/server";
import { runFixtureSync } from "@/lib/sports-data/sync-fixtures";
import { recordJobRun } from "@/lib/jobs/record";

// The route keeps its original path and job name (so the external scheduler entry and job-health history are untouched), but it now syncs
// EVERY active sport (NFL, NBA, NHL) through the one shared sync, each failure-isolated.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("sync-fixtures-nfl", () => runFixtureSync());
  return NextResponse.json(result);
}
