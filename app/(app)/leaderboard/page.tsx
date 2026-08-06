import { Trophy } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Podium, type LeaderboardEntry } from "@/components/leaderboard/Podium";
import { RankedList } from "@/components/leaderboard/RankedList";
import { StreakWidget } from "@/components/leaderboard/StreakWidget";
import { LeaderboardFilters } from "./leaderboard-filters";

type Scope = "global" | "following";
type Range = "all_time" | "weekly" | "monthly";

function isScope(value: string | undefined): value is Scope {
  return value === "global" || value === "following";
}

function isRange(value: string | undefined): value is Range {
  return value === "all_time" || value === "weekly" || value === "monthly";
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; range?: string }>;
}) {
  const { scope: scopeParam, range: rangeParam } = await searchParams;
  const scope: Scope = isScope(scopeParam) ? scopeParam : "global";
  const range: Range = isRange(rangeParam) ? rangeParam : "all_time";

  const user = await requireUser();
  const supabase = await createClient();

  const [{ data: rows }, { data: profile }] = await Promise.all([
    supabase.rpc("get_leaderboard", { p_scope: scope, p_range: range, p_caller_id: user.id }),
    supabase.from("user_profiles").select("current_streak, best_streak").eq("id", user.id).single(),
  ]);

  const leaderboard: LeaderboardEntry[] = (rows ?? []).map(
    (row: {
      user_id: string;
      display_name: string;
      username: string | null;
      avatar_url: string | null;
      correct_count: number;
      total_count: number;
      rank: number;
    }) => ({
      userId: row.user_id,
      displayName: row.display_name,
      username: row.username,
      avatarUrl: row.avatar_url,
      correctCount: row.correct_count,
      totalCount: row.total_count,
      rank: row.rank,
    }),
  );

  const podium = leaderboard.slice(0, 3);
  const ownEntry = leaderboard.find((entry) => entry.userId === user.id);
  // Only worth a jump link once you're not already visible in the podium
  // above — for the top 3, "where do I stand" is already answered at a
  // glance.
  const showJumpToRank = ownEntry != null && ownEntry.rank > 3;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Leaderboard</h1>
      <LeaderboardFilters />

      {/* Personal, emotionally-resonant stat leads the page — kept
          unconditional (not nested inside the empty-state branch below): a
          real streak value is still meaningful even before any ranked
          entries exist yet. */}
      <div className="space-y-2">
        <StreakWidget currentStreak={profile?.current_streak ?? 0} bestStreak={profile?.best_streak ?? 0} />
        {showJumpToRank && (
          <a
            href={`#row-${user.id}`}
            className="text-xs font-medium text-accent-primary hover:underline"
          >
            Jump to your rank (#{ownEntry.rank})
          </a>
        )}
      </div>

      {leaderboard.length === 0 ? (
        <EmptyFeedState
          icon={Trophy}
          title="No rankings yet"
          description={
            scope === "following"
              ? "Follow other players to see how you compare."
              : "Once predictions start settling, rankings will show up here."
          }
        />
      ) : (
        <>
          <Podium entries={podium} currentUserId={user.id} />
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-text-primary">Rankings</h2>
            {/* Full standings, not just 4th place on — the top 3 belong at
                the top of the complete list too, not only up in the podium. */}
            <RankedList entries={leaderboard} currentUserId={user.id} />
          </div>
        </>
      )}
    </div>
  );
}
