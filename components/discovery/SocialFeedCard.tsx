import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import type { FeedItem } from "@/lib/communities/feed";

// Stage 4A remediation (Stage 4 audit §2-3 P0 fix) — the canonical social
// feed card. Links straight to the canonical Post (never a copy), shows
// the primary Market's semantic question/labels (never raw YES/NO), and
// surfaces the Post's Community context inline so a user encountering
// "Chiefs vs Dolphins" can discover the relevant Communities without
// knowing a slug (§10). "Following" only changes ranking (a small badge
// here), never which Posts are reachable at all (§5-6).

function gameStatusLabel(internalStatus: string, homeScore: number | null, awayScore: number | null): string | null {
  if (internalStatus === "COMPLETED" && homeScore != null && awayScore != null) return `Final ${awayScore}-${homeScore}`;
  if (["LIVE", "HALFTIME", "EXTRA_TIME", "PENALTIES"].includes(internalStatus)) return "Live";
  return null;
}

export function SocialFeedCard({ item }: { item: FeedItem }) {
  const statusLabel = gameStatusLabel(item.internalStatus, item.homeScore, item.awayScore);

  return (
    <Link href={`/post/${item.post.id}`} className="block">
      <Card className="transition-colors hover:border-accent-primary/50">
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center justify-between gap-2">
            <p className="text-base font-semibold text-text-primary">
              {item.awayTeamName} @ {item.homeTeamName}
            </p>
            {item.isFromFollowedCommunity && (
              <span className="shrink-0 rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs font-medium text-accent-primary">Following</span>
            )}
          </div>

          <p className="text-sm text-text-secondary">
            {statusLabel ?? <LocalDateTime iso={item.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
            {item.competitionName && ` · ${item.competitionName}`}
          </p>

          {item.primaryMarket && (
            <div className="rounded-lg bg-secondary p-3">
              <p className="text-sm font-medium text-text-primary">{item.primaryMarket.question}</p>
              {item.primaryMarket.yesPercent != null && item.primaryMarket.noPercent != null && (
                <p className="mt-1 text-xs text-text-muted">
                  {item.primaryMarket.yesLabel} {item.primaryMarket.yesPercent}% · {item.primaryMarket.noLabel} {item.primaryMarket.noPercent}%
                </p>
              )}
            </div>
          )}

          {item.communities.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.communities.map((c) => (
                <span key={c.id} className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-muted">
                  {c.displayName}
                  <span className="sr-only"> ({getCommunityTypeLabel(c.type)})</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
