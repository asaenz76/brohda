import { NextResponse } from "next/server";
import { runNflMarketIngestion } from "@/lib/prediction-markets/ingestion/nfl";
import { recordJobRun } from "@/lib/jobs/record";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("ingest-nfl-markets", () => runNflMarketIngestion());
  return NextResponse.json(result);
}
