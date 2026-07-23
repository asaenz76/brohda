import { NextResponse } from "next/server";
import { processAwaitingResults } from "@/lib/pools/settle";
import { recordJobRun } from "@/lib/jobs/record";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("process-results", () => processAwaitingResults());
  return NextResponse.json(result);
}
