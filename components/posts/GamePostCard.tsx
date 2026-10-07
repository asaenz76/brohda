import Link from "next/link";
import { ChevronRight, MessageCircle } from "lucide-react";
import { LeagueCrest } from "@/components/LeagueCrest";
import { SponsoredLabel } from "@/components/sponsorship/SponsoredLabel";
import { resolveLeagueIdentity } from "@/lib/sports-data/league-crest";
import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { MatchupHeading } from "@/components/posts/MatchupHeading";
import { formatMatchupScores, formatMatchupSpoken } from "@/lib/sports-data/team-display-order";
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

/**
 * Brohda's crowd sentiment, Pick-first: percentages for both visible sides and the predicted count appear only AFTER the viewer has made
 * a Pick (and stay once it changes, locks or is graded). Logged-out visitors can't pick, so they never see them. This is social sentiment,
 * never a betting probability. Before a Pick, a single nudge says where it comes from.
 */
function SentimentLine({ market, isPublic }: { market: NonNullable<FeedItem["primaryMarket"]>; isPublic: boolean }) {
  if (!isPublic && market.sentimentRevealed) {
    return (
      <p className="text-xs text-text-muted">
        {market.choices.map((c) => `${c.label} ${c.outcome === "YES" ? market.yesPercent : market.noPercent}%`).join(" · ")} · {market.totalPickCount} predicted
      </p>
    );
  }
  // Nothing to nudge toward when picking isn't possible right now (locked / closed game).
  if (market.pickDisabledReason) return null;
  return <p className="text-xs text-text-muted">Make your pick to see how everyone else picked.</p>;
}

function gameStatusLabel(sport: string, internalStatus: string, homeScore: number | null, awayScore: number | null): string | null {
  if (internalStatus === "COMPLETED" && homeScore != null && awayScore != null) return `Final ${formatMatchupScores(sport, homeScore, awayScore)}`;
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
  const statusLabel = gameStatusLabel(item.sport, item.internalStatus, item.homeScore, item.awayScore);
  const market = item.primaryMarket;
  const moreMarkets = item.moreMarketsCount ?? 0;
  const league = resolveLeagueIdentity({ competitionName: item.competitionName, competitionLogoUrl: item.competitionLogoUrl });
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
            <span className="sr-only">Game published by Brohda. </span>
            <LeagueCrest league={league} />
          </p>
          {!isPublic && item.isFromFollowedCommunity && (
            <span className="shrink-0 rounded-full bg-accent-primary/10 px-2 py-0.5 text-xs font-medium text-accent-primary">Following</span>
          )}
        </div>
        {item.sponsorship && <SponsoredLabel sponsorship={item.sponsorship} trackImpression={!isPublic} />}
        <Link href={`/post/${item.post.id}`} className="block space-y-3">
          <p className="flex flex-wrap items-center gap-1.5 text-base font-semibold text-text-primary">
            <MatchupHeading
              sport={item.sport}
              homeTeamName={item.homeTeamName}
              awayTeamName={item.awayTeamName}
              homeTeamLogoUrl={item.homeTeamLogoUrl}
              awayTeamLogoUrl={item.awayTeamLogoUrl}
            />
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
                <PublicPickChoices choices={market.choices} postId={item.post.id} />
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

            <SentimentLine market={market} isPublic={isPublic} />

            {moreMarkets > 0 && (
              // A visible, separate action: nobody has to discover that the card is clickable to reach the Game's other Markets. Same canonical Post as the
              // card link (a sibling link, not nested), so there is one destination and Back returns exactly where the user came from.
              <Link
                href={`/post/${item.post.id}`}
                data-slot="see-more-markets"
                aria-label={`See more markets for ${formatMatchupSpoken(item.sport, item.homeTeamName, item.awayTeamName)}`}
                className="-mx-1 inline-flex min-h-9 items-center gap-0.5 rounded-md px-1 text-xs font-semibold uppercase tracking-wide text-accent-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                See more markets
                <ChevronRight className="size-3.5" aria-hidden="true" />
              </Link>
            )}
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

  return <article aria-label={`Game: ${formatMatchupSpoken(item.sport, item.homeTeamName, item.awayTeamName)}`}>{card}</article>;
}
