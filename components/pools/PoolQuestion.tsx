// The single, question-first heading every card hierarchy leads to — never
// exposes the underlying template id (MONEYLINE_FAVORITE, SPREAD_FAVORITE,
// GAME_TOTAL, ...), only the human-readable question. This is the card's
// visual hero (matches the approved mockup): large, centered, bold, with
// real room around it. The grading-rule text is real, useful context but
// must never compete with the question for attention — a plain small
// muted line, not a second pill-shaped headline.
export function PoolQuestion({ question, ruleLabel }: { question: string; ruleLabel: string }) {
  return (
    <div className="space-y-1 text-center">
      <h3 className="text-xl font-bold text-balance text-text-primary sm:text-2xl">{question}</h3>
      <p className="text-xs text-text-muted">{ruleLabel}</p>
    </div>
  );
}
