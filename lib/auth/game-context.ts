import "server-only";
import { getPublishedPostById } from "@/lib/posts/repository";
import { getFixtureForPostPresentation } from "@/lib/sports-data/fixture-lookup";
import { formatMatchup } from "@/lib/sports-data/team-display-order";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { listDisplayableMarketsForFixture } from "@/lib/prediction-markets/repository";
import { marketsOfAllowedTemplates } from "@/lib/prediction-markets/market-policy-parse";
import { getPredictionPolicy } from "@/lib/predictions/policy";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { parsePickIntent, pickIntentFromNext, postIdFromNext } from "./pick-intent";

export interface AuthGameIntent {
  /** The Game in the sport's own matchup order ("Carolina Panthers @ Green Bay Packers"). */
  matchup: string;
  /** The side the visitor tapped, as the Game's own Pick control names it ("Green Bay Packers"), or null when no side was tapped (or it cannot be named). It is intent only: nothing is saved until they confirm on the Game. */
  choiceLabel: string | null;
}

/** The Game a sign-up / log-in is for, and the side the visitor tapped — or null when `next` is not a published Game's Post. Public facts only (the same ones the front door shows). Never throws. */
export async function getAuthGameIntent(next: unknown): Promise<AuthGameIntent | null> {
  const postId = postIdFromNext(next);
  if (!postId) return null;
  try {
    const post = await getPublishedPostById(postId);
    if (!post) return null;
    const fixture = await getFixtureForPostPresentation(post.fixtureId);
    if (!fixture) return null;
    const matchup = formatMatchup(fixture.sport, fixture.homeTeamName, fixture.awayTeamName);
    const outcome = parsePickIntent(pickIntentFromNext(next));
    if (!outcome) return { matchup, choiceLabel: null };
    // The side is named by the same Market and the same labels the Post's Pick control uses, so "You chose X" here and on the Game can never disagree. Naming it is a courtesy: any failure just leaves it out.
    const choiceLabel = await (async () => {
      try {
        const [markets, predictionPolicy, postPolicy] = await Promise.all([listDisplayableMarketsForFixture(post.fixtureId), getPredictionPolicy(), getPostPublicationPolicy()]);
        const primary = selectPrimaryMarket(marketsOfAllowedTemplates(markets, predictionPolicy.allowedTemplates), postPolicy.primaryMarketTemplatePriority);
        return primary ? getSelectionLabel({ ...primary, homeTeamName: fixture.homeTeamName, awayTeamName: fixture.awayTeamName, sport: fixture.sport }, outcome) : null;
      } catch {
        return null;
      }
    })();
    return { matchup, choiceLabel };
  } catch {
    return null;
  }
}

/** The Game a sign-up / log-in is for, named in the sport's own matchup order — or null when `next` is not a published Game's Post. */
export async function getAuthGameMatchup(next: unknown): Promise<string | null> {
  return (await getAuthGameIntent(next))?.matchup ?? null;
}
