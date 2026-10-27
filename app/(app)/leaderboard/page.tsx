import { redirect } from "next/navigation";
import { ListOrdered } from "lucide-react";
import { requireSocialPredictionAccess } from "@/lib/social/access";
import { getLeaderboardConfig } from "@/lib/leaderboard/config";
import { getWeeklyLeaderboard } from "@/lib/leaderboard/repository";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { WeeklyLeaderboardView } from "@/components/leaderboard/WeeklyLeaderboardView";
import { Card, CardContent } from "@/components/ui/card";
import type { WeeklyLeaderboard } from "@/lib/leaderboard/types";

// Brohda 2.1 M6 — the weekly leaderboard: how you are doing against everyone else right now. Signed-in Members only (the same audience as profiles); the whole page exists only while the capability is on
// (leaderboard_enabled, default off) — otherwise /leaderboard behaves exactly as it did before M6 and sends a visitor to their profile.
export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const user = await requireSocialPredictionAccess();
  if (!(await getLeaderboardConfig())) redirect("/profile");

  let board: WeeklyLeaderboard | null = null;
  try {
    board = await getWeeklyLeaderboard(user.id);
  } catch (error) {
    console.error("[leaderboard] could not load the weekly leaderboard", error);
  }

  return (
    <div>
      <ColumnHeader title="Leaderboard" icon={ListOrdered} />
      <div className="px-4 py-4 md:px-0">
        {board ? (
          <WeeklyLeaderboardView board={board} viewerUserId={user.id} now={new Date()} />
        ) : (
          <Card>
            <CardContent className="pt-4" data-slot="leaderboard-error">
              <p className="text-sm text-text-secondary">The leaderboard couldn&apos;t load right now. Try again in a moment.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
