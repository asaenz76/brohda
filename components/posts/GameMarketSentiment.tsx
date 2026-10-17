import { formatConfidence } from "@/lib/confidence/format";
import type { GameMarketSentiment as Sentiment } from "@/lib/posts/game-sentiment";

/**
 * How the crowd picked, per Market, on the opened Post. Information only — the Post has no Pick buttons and no Confidence control (the feed is where a prediction is made). Each Market is one labelled block with both sides'
 * shares and how many predicted. A Market the viewer has not predicted on yet says where the numbers come from instead of showing them (commit-before-crowd), and a Market nobody has picked says so — it never shows 0% / 0%.
 */
export function GameMarketSentimentSection({ markets }: { markets: Sentiment[] }) {
  if (markets.length === 0) return null;
  return (
    <section aria-label="Market sentiment" data-slot="game-sentiment" className="space-y-4">
      {markets.map((m) => (
        <div key={m.marketId} data-slot="market-sentiment-block" data-market-id={m.marketId} className="space-y-1.5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-muted">{m.label}</h2>
          {!m.revealed ? (
            <p className="text-sm text-text-muted">Make your pick in the feed to see how everyone else picked.</p>
          ) : m.totalPickCount === 0 ? (
            <p className="text-sm text-text-muted">No one has predicted yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
                {m.choices.map((c) => (
                  <div key={c.outcome} className="min-w-0">
                    <p className="text-3xl font-bold text-text-primary">{c.percent}%</p>
                    <p className="break-words text-xs font-medium uppercase tracking-wide text-text-muted">{c.label}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-text-muted">{m.totalPickCount} predicted</p>
            </>
          )}
          {m.viewerChoiceLabel && (
            <p className="text-xs text-text-muted" data-slot="your-prediction">
              Your prediction: <span className="font-medium text-text-secondary">{m.viewerChoiceLabel}</span>
              {m.viewerConfidence !== null && <> · {formatConfidence(m.viewerConfidence)}</>}
              {m.viewerResult && <> · Result: {m.viewerResult === "CORRECT" ? "Correct" : m.viewerResult === "INCORRECT" ? "Incorrect" : "Void — this one didn’t count"}</>}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
