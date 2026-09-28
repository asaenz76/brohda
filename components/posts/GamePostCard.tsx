import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { TeamCrest } from "@/components/TeamCrest";
import { PredictionActions } from "@/components/predictions/PredictionActions";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import type { FeedItem } from "@/lib/communities/feed";

// Phase C (Brohda 2.0 redesign) — the canonical Home timeline's Game Post,
// refined from Stage 4A's SocialFeedCard (components/discovery/
// SocialFeedCard.tsx, now retired — this file supersedes it; /markets
// imports this same component, see that page's own comment for why the
// two temporarily show the same content). Spec §12's "minimum coherent
// social Game Post": teams/crests, matchup, league/sport, kickoff/state,
// primary question, semantic Pick choices (interactive, not just
// read-only), viewer's own Pick, comment count, restrained Community
// context. No Call BS, no money, no odds.
//
// Interactive Pick buttons (PredictionActions, a real <button> each)
// cannot nest inside the card's own `Link` to /post/[id] (invalid HTML,
// and would fight the Link's own click) — only the identity/status/
// question block above them is a Link; the Pick control and comment link
// below are separate, sibling interactive regions.

function gameStatusLabel(internalStatus: string, homeScore: number | null, awayScore: number | null): string | null {
  if (internalStatus === "COMPLETED" && homeScore != null && awayScore != null) return `Final ${awayScore}-${homeScore}`;
  if (["LIVE", "HALFTIME", "EXTRA_TIME", "PENALTIES"].includes(internalStatus)) return "Live";
  return null;
}

export function GamePostCard({ item }: { item: FeedItem }) {
  const statusLabel = gameStatusLabel(item.internalStatus, item.homeScore, item.awayScore);
  const market = item.primaryMarket;
  // Restraint (spec §20): a Post can belong to several Communities at
  // once (home team, away team, league, sport) — show at most a couple,
  // never a wall of badges.
  const visibleCommunities = item.communities.slice(0, 2);
  const extraCommunityCount = item.communities.length - visibleCommunities.length;

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <Link href={`/post/${item.post.id}`} className="block space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex flex-wrap items-center gap-1.5 text-base font-semibold text-text-primary">
              <TeamCrest logoUrl={item.awayTeamLogoUrl} teamName={item.awayTeamName} />
              {item.awayTeamName} @ <TeamCrest logoUrl={item.homeTeamLogoUrl} teamName={item.homeTeamName} />
              {item.homeTeamName}
            </p>
            {item.isFromFollowedCommunity && (
              <span className="shrink-0 rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs font-medium text-accent-primary">Following</span>
            )}
          </div>

          <p className="text-sm text-text-secondary">
            {statusLabel ?? <LocalDateTime iso={item.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
            {item.competitionName && ` · ${item.competitionName}`}
          </p>

          {market && <p className="text-sm font-medium text-text-primary">{market.question}</p>}
        </Link>

        {market && (
          <div className="space-y-2 rounded-lg bg-secondary p-3">
            {market.isEditable ? (
              <PredictionActions
                marketId={market.id}
                disabledReason={market.pickDisabledReason}
                currentSelection={market.viewerSelection}
                yesLabel={market.yesLabel}
                noLabel={market.noLabel}
              />
            ) : (
              <p className="text-sm font-medium text-text-muted">
                You picked {market.viewerSelection === "YES" ? market.yesLabel : market.noLabel} — {market.pickDisabledReason}
              </p>
            )}

            <p className="text-xs text-text-muted">
              {market.totalPickCount > 0
                ? `${market.yesLabel} ${market.yesPercent}% · ${market.noLabel} ${market.noPercent}% · ${market.totalPickCount} predicted`
                : "No one has predicted yet."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {visibleCommunities.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleCommunities.map((c) => (
                <Link
                  key={c.id}
                  href={`/community/${c.slug}`}
                  className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-muted hover:border-accent-primary/50 hover:text-text-primary"
                >
                  {c.displayName}
                  <span className="sr-only"> ({getCommunityTypeLabel(c.type)})</span>
                </Link>
              ))}
              {extraCommunityCount > 0 && <span className="text-xs text-text-muted">+{extraCommunityCount}</span>}
            </div>
          ) : (
            <span />
          )}

          <Link href={`/post/${item.post.id}`} className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary">
            <MessageCircle className="size-3.5" aria-hidden="true" />
            {item.commentCount} {item.commentCount === 1 ? "comment" : "comments"}
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
