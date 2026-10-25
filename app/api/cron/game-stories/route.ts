import { NextResponse } from "next/server";
import { recordJobRun } from "@/lib/jobs/record";
import { runScheduledStories } from "@/lib/game-stories/service";

// The scheduled Game Story research, on its OWN route and external scheduler entry. A no-op until `game_story_config.generation_enabled` is switched on (off = no candidate query, no provider call, no write).
// Output is CANDIDATES for Admin review only: auto-publish does not exist in M3. One Game takes ~100 s, so the run is limited to what fits in this function's 300 s.
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The overlap lock outlives the function's own limit, so a second tick can never start while a run is still going.
  const result = await recordJobRun("game-stories", () => runScheduledStories(), 15 * 60);
  return NextResponse.json(result);
}
