import { NextResponse } from "next/server";
import { runGamePreviewAutomation } from "@/lib/game-previews/automation";
import { recordJobRun } from "@/lib/jobs/record";

// The scheduled Game Preview automation, on its OWN route and its own external scheduler entry (one run a day at the initial rollout). It is a no-op until `game_preview_config.generation_enabled` is switched on:
// off means no candidate query, no provider call, no search and no write. One Game takes about 100 s, so the run is limited to what fits in this function's 300 s (a Game is started only when its expected time still fits).
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The overlap lock outlives the function's own limit, so a second tick can never start while a run is still going.
  const result = await recordJobRun("game-previews", () => runGamePreviewAutomation(), 15 * 60);
  return NextResponse.json(result);
}
