import { NextResponse } from "next/server";
import { runMarketIngestion } from "@/lib/prediction-markets/ingestion/sports";
import { recordJobRun } from "@/lib/jobs/record";

// Original path and job name kept (scheduler entry + job-health history untouched); it now ingests Markets for EVERY active sport, each isolated.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("ingest-nfl-markets", () => runMarketIngestion());
  return NextResponse.json(result);
}
