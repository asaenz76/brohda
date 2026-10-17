import "server-only";
import type { MarketRecord } from "@/lib/prediction-markets/repository";
import { getChoicePresentation } from "@/lib/prediction-markets/selection-labels";
import { getPickAggregatesForMarkets, listLatestUserPredictionsForMarkets } from "@/lib/predictions/repository";
import { computePickSentiment } from "@/lib/predictions/sentiment";
import { getStakeUiStates } from "@/lib/confidence/stakes";

/**
 * What the opened Post says about each Market of the Game: how the crowd picked, for the Markets the viewer has made a FINAL prediction on. The Post is not a prediction surface (the feed is), so there are no Pick buttons here;
 * but the product's commit-before-crowd rule is the same everywhere: crowd percentages and counts are withheld until the viewer's own prediction on THAT Market is final, so no surface can show them by accident.
 * One Pick is one vote (Confidence never weights it), the numbers are the canonical aggregate (never provider odds, never fabricated), and a Market nobody has picked is "no one yet", never 0% / 0%.
 * A constant number of batched reads however many Markets the Game has.
 */
export interface GameMarketSentiment {
  marketId: string;
  /** "Moneyline", "Total 6", "Spread" — the same compact label every other surface uses. */
  label: string;
  /** Both visible sides, in the canonical choice order, each with its own team-native label and share (null until revealed or while nobody has picked). */
  choices: Array<{ outcome: "YES" | "NO"; label: string; percent: number | null }>;
  /** True once the viewer's prediction on this Market is final. */
  revealed: boolean;
  /** The viewer has ANY Pick on this Market, including an old open one not yet completed with Confidence (Other Picks / Call BS gate on this, exactly as before). */
  hasViewerPick: boolean;
  totalPickCount: number;
  /** The viewer's own prediction on this Market, as context ("Washington Capitals · 🔥5"): the side, and the Confidence behind it when there is one. */
  viewerChoiceLabel: string | null;
  viewerConfidence: number | null;
  /** How the viewer's prediction on this Market came out, once the Game is graded (null until then). */
  viewerResult: "CORRECT" | "INCORRECT" | "VOID" | null;
}

export async function getGameMarketSentiment({
  userId,
  sport,
  homeTeamName,
  awayTeamName,
  markets,
  templatePriority,
}: {
  userId: string;
  sport: string;
  homeTeamName: string;
  awayTeamName: string;
  markets: MarketRecord[];
  /** The configured template order (the same setting that chooses the primary Market): Moneyline, Total, Spread by default. */
  templatePriority: string[];
}): Promise<GameMarketSentiment[]> {
  if (markets.length === 0) return [];
  const rank = (template: string) => {
    const at = templatePriority.indexOf(template);
    return at === -1 ? templatePriority.length : at;
  };
  const ordered = [...markets].sort((a, b) => rank(a.marketTemplate) - rank(b.marketTemplate) || a.id.localeCompare(b.id));
  const predictions = await listLatestUserPredictionsForMarkets(
    userId,
    ordered.map((m) => m.id),
  );
  const isFinal = (marketId: string) => {
    const p = predictions.get(marketId);
    return p !== undefined && (p.lockedAt !== null || p.lifecycleState !== "PENDING");
  };
  const revealedIds = ordered.filter((m) => isFinal(m.id)).map((m) => m.id);
  const [aggregates, stakes] = await Promise.all([
    revealedIds.length ? getPickAggregatesForMarkets(revealedIds) : Promise.resolve(new Map()),
    getStakeUiStates(userId, [...predictions.values()].map((p) => p.id)),
  ]);

  return ordered.map((market) => {
    const presentation = getChoicePresentation({ ...market, homeTeamName, awayTeamName, sport });
    const revealed = isFinal(market.id);
    const sentiment = revealed ? computePickSentiment(aggregates.get(market.id)) : { yesPercent: null, noPercent: null, totalPickCount: 0 };
    const prediction = predictions.get(market.id);
    const stake = prediction ? stakes.get(prediction.id) : undefined;
    return {
      marketId: market.id,
      label: presentation.marketLabel ?? market.question,
      choices: presentation.choices.map((c) => ({ outcome: c.outcome as "YES" | "NO", label: c.label, percent: c.outcome === "YES" ? sentiment.yesPercent : sentiment.noPercent })),
      revealed,
      hasViewerPick: prediction !== undefined,
      totalPickCount: sentiment.totalPickCount,
      viewerChoiceLabel: revealed && prediction ? (presentation.choices.find((c) => c.outcome === prediction.selectedOutcome)?.label ?? null) : null,
      viewerConfidence: revealed && stake && stake.state === "staked" ? stake.amount : null,
      viewerResult: revealed && prediction ? ((prediction.result as "CORRECT" | "INCORRECT" | "VOID" | null) ?? null) : null,
    };
  });
}
