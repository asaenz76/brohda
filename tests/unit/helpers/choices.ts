import { getChoicePresentation, type SelectionLabelSource } from "@/lib/prediction-markets/selection-labels";

/** The label fields a feed/market summary carries, built through the real shared presentation (never hand-written labels). */
export function choiceFields(source: SelectionLabelSource) {
  const p = getChoicePresentation(source);
  return {
    yesLabel: p.choices.find((c) => c.outcome === "YES")!.label,
    noLabel: p.choices.find((c) => c.outcome === "NO")!.label,
    choices: p.choices,
    marketLabel: p.marketLabel,
  };
}

/** A real NFL moneyline (home = YES, as ingestion creates it), read Away @ Home. */
export const nflMoneyline = (home: string, away: string) => choiceFields({ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, homeTeamName: home, awayTeamName: away, sport: "american_football" });
