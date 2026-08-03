import { NextResponse } from "next/server";
import { runCompetitionImportProcessing } from "@/lib/competitions/process-imports-cron";
import { recordJobRun } from "@/lib/jobs/record";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("process-competition-imports", () => runCompetitionImportProcessing());
  return NextResponse.json(result);
}
