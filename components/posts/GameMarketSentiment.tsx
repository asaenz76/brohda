import { formatConfidence } from "@/lib/confidence/format";
import type { GameMarketSentiment as Sentiment } from "@/lib/posts/game-sentiment";

/**
 * How the crowd picked, per Market, on the opened Post. Information only — the Post has no Pick buttons and no Confidence control (the feed is where a prediction is made). Each Market is one compact block: its label and how many
 * predicted on one line, then both sides' shares side by side in two even columns (small, readable type — this is context, not the headline). A Market the viewer has not predicted on yet says where the numbers come from instead of
 * showing them (commit-before-crowd), and a Market nobody has picked says so — it never shows 0% / 0%.
 */
export function GameMarketSentimentSection({ markets }: { markets: Sentiment[] }) {
  if (markets.length === 0) return null;
  return (
    <section aria-label="Market sentiment" data-slot="game-sentiment" className="space-y-3.5">
      {markets.map((m) => {
        const showShares = m.revealed && m.totalPickCount > 0;
        return (
          <div key={m.marketId} data-slot="market-sentiment-block" data-market-id={m.marketId} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">{m.label}</h2>
              {showShares && <p className="shrink-0 text-xs text-text-muted">{m.totalPickCount} predicted</p>}
            </div>
            {!m.revealed ? (
              <p className="text-sm text-text-muted">Make your prediction in the feed to see how everyone else picked.</p>
            ) : m.totalPickCount === 0 ? (
              <p className="text-sm text-text-muted">No one has predicted yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-4" data-slot="sentiment-shares">
                {m.choices.map((c) => (
                  <div key={c.outcome} className="flex min-w-0 items-baseline gap-2">
                    <span className="text-lg font-semibold tabular-nums leading-none text-text-primary">{c.percent}%</span>
                    <span className="min-w-0 break-words text-xs font-medium uppercase leading-tight tracking-wide text-text-muted">{c.label}</span>
                  </div>
                ))}
              </div>
            )}
            {m.viewerChoiceLabel && (
              <p className="text-xs text-text-muted" data-slot="your-prediction">
                Your prediction: <span className="font-medium text-text-secondary">{m.viewerChoiceLabel}</span>
                {m.viewerConfidence !== null && <> · {formatConfidence(m.viewerConfidence)}</>}
                {m.viewerResult && <> · Result: {m.viewerResult === "CORRECT" ? "Correct" : m.viewerResult === "INCORRECT" ? "Incorrect" : "Void — this one didn’t count"}</>}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
