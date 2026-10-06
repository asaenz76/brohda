import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { TeamCrest } from "@/components/TeamCrest";
import { PredictionActions } from "@/components/predictions/PredictionActions";
import { PublicPickChoices } from "@/components/posts/PublicPickChoices";
import { getCommunityTypeLabel } from "@/lib/communities/presentation";
import type { FeedItem } from "@/lib/communities/feed";
import { MONEYLINE_MARKET_LABEL } from "@/lib/prediction-markets/selection-labels";

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

/**
 * What names the Market on a Game Post card. The two team (or Over/Under) choices below already say what is being picked, so a Moneyline
 * needs no line of its own; a Spread or Total gets its compact label; and only a Market without a template-aware label (a historical or
 * unsupported one) falls back to its original question.
 */
function MarketContext({ market }: { market: NonNullable<FeedItem["primaryMarket"]> }) {
  if (market.marketLabel === MONEYLINE_MARKET_LABEL) return null;
  return <p className="text-sm font-medium text-text-primary">{market.marketLabel ?? market.question}</p>;
}

function gameStatusLabel(internalStatus: string, homeScore: number | null, awayScore: number | null): string | null {
  if (internalStatus === "COMPLETED" && homeScore != null && awayScore != null) return `Final ${awayScore}-${homeScore}`;
  if (["LIVE", "HALFTIME", "EXTRA_TIME", "PENALTIES"].includes(internalStatus)) return "Live";
  return null;
}

/**
 * One Game Post, two audiences. The card is identical for a member and for
 * a logged-out visitor — same matchup, status, question, sentiment and
 * spacing — so signing in never changes how a Game looks, only what you can
 * do with it. Both modes open with the same authorship line ("Brohda ·
 * competition"): a Game is published by the platform and never has a user
 * author. `mode="public"` (the front door,
 * components/landing/PublicFrontDoor.tsx) differs only in capability:
 *   1. the Pick control becomes links to sign-up (PublicPickChoices)
 *      instead of mutation buttons;
 *   2. Community chips are plain text, since Community pages need an
 *      account;
 *   3. there is no "Following" marker, since there is no viewer.
 * Money controls never appear on this card in either mode (they live on the
 * Post detail, inside MarketParticipants). `member` is the default.
 */
export function GamePostCard({ item, mode = "member" }: { item: FeedItem; mode?: "member" | "public" }) {
  const isPublic = mode === "public";
  const statusLabel = gameStatusLabel(item.internalStatus, item.homeScore, item.awayScore);
  const market = item.primaryMarket;
  // Restraint (spec §20): a Post can belong to several Communities at
  // once (home team, away team, league, sport) — show at most a couple,
  // never a wall of badges.
  const visibleCommunities = item.communities.slice(0, 2);
  const extraCommunityCount = item.communities.length - visibleCommunities.length;

  const card = (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-text-muted">
            <span className="sr-only">Game published by </span>
            <span className="font-medium text-text-secondary">Brohda</span>
            {item.competitionName && ` · ${item.competitionName}`}
          </p>
          {!isPublic && item.isFromFollowedCommunity && (
            <span className="shrink-0 rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs font-medium text-accent-primary">Following</span>
          )}
        </div>
        <Link href={`/post/${item.post.id}`} className="block space-y-3">
          <p className="flex flex-wrap items-center gap-1.5 text-base font-semibold text-text-primary">
            <TeamCrest logoUrl={item.awayTeamLogoUrl} teamName={item.awayTeamName} />
            {item.awayTeamName} @ <TeamCrest logoUrl={item.homeTeamLogoUrl} teamName={item.homeTeamName} />
            {item.homeTeamName}
          </p>

          <p className="text-sm text-text-secondary">
            {statusLabel ?? <LocalDateTime iso={item.scheduledStartUtc} options={{ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />}
          </p>

          {market && <MarketContext market={market} />}
        </Link>

        {market && (
          <div className="space-y-2 rounded-lg bg-secondary p-3">
            {isPublic ? (
              market.pickDisabledReason ? (
                <p className="text-sm font-medium text-text-muted">{market.pickDisabledReason}</p>
              ) : (
                <PublicPickChoices choices={market.choices} />
              )
            ) : market.isEditable ? (
              <PredictionActions
                marketId={market.id}
                disabledReason={market.pickDisabledReason}
                currentSelection={market.viewerSelection}
                choices={market.choices}
              />
            ) : (
              <p className="text-sm font-medium text-text-muted">
                You picked {market.choices.find((c) => c.outcome === market.viewerSelection)?.label} — {market.pickDisabledReason}
              </p>
            )}

            <p className="text-xs text-text-muted">
              {market.totalPickCount > 0
                ? `${market.choices.map((c) => `${c.label} ${c.outcome === "YES" ? market.yesPercent : market.noPercent}%`).join(" · ")} · ${market.totalPickCount} predicted`
                : "No one has predicted yet."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {visibleCommunities.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleCommunities.map((c) =>
                isPublic ? (
                  <span key={c.id} className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-muted">
                    {c.displayName}
                    <span className="sr-only"> ({getCommunityTypeLabel(c.type)})</span>
                  </span>
                ) : (
                  <Link
                    key={c.id}
                    href={`/community/${c.slug}`}
                    className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-text-muted hover:border-accent-primary/50 hover:text-text-primary"
                  >
                    {c.displayName}
                    <span className="sr-only"> ({getCommunityTypeLabel(c.type)})</span>
                  </Link>
                ),
              )}
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

  return <article aria-label={`Game: ${item.awayTeamName} at ${item.homeTeamName}`}>{card}</article>;
}
