import { NextResponse } from "next/server";
import { runPostPublication } from "@/lib/posts/publication";
import { recordJobRun } from "@/lib/jobs/record";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await recordJobRun("publish-posts", () => runPostPublication());
  return NextResponse.json(result);
}
