interface CommunitySplitOption {
  label: string;
  percentage: number | null;
}

// Entry-count-based split, not money-weighted — copy/labels here must
// never imply a dollar/stake weighting (e.g. "money is leaning X%").
// Percentages arrive already privacy-filtered from the view-model (null
// pre-entry, once the viewer has entered or the pool is live/resolved).
//
// Deliberately restrained: the ordinary binary case (today's entire NFL
// product) is exactly two segments — accent-primary for the leading side,
// a neutral gray for the other — matching the approved mockup's large
// flanking "62% | 38%" numbers either side of the bar. A third tone
// (text-muted) only comes into play for historical 3-way pools
// (REGULATION_RESULT's Home/Draw/Away), which fall back to the older
// below-bar label list — flanking numbers only make sense either side of a
// two-segment bar. Segments are ordered by option position, not by
// percentage, matching the choice-button order above them.
const SEGMENT_COLORS = ["bg-accent-primary", "bg-border-strong", "bg-text-muted"];
const NUMBER_COLORS = ["text-accent-primary", "text-text-muted", "text-text-muted"];

export function CommunitySplit({ options }: { options: CommunitySplitOption[] }) {
  const visible = options.filter((o): o is { label: string; percentage: number } => o.percentage != null);
  if (visible.length === 0) return null;

  const bar = (
    <div className="flex h-3 flex-1 overflow-hidden rounded-full bg-surface-secondary" aria-hidden="true">
      {visible.map((option, i) => (
        <div
          key={option.label}
          className={SEGMENT_COLORS[i % SEGMENT_COLORS.length]}
          style={{ width: `${option.percentage}%` }}
        />
      ))}
    </div>
  );

  if (visible.length === 2) {
    return (
      <div
        className="flex items-center gap-4"
        aria-label={`Community split: ${visible.map((o) => `${o.label} ${o.percentage}%`).join(", ")}`}
      >
        <span className="flex shrink-0 items-center gap-1.5">
          {/* A small color dot next to each percentage — same segment
              color as the bar below it — is what actually reads as "a
              real split" at a glance, not just two gray numbers either
              side of a bar. */}
          <span className={`size-2.5 shrink-0 rounded-full ${SEGMENT_COLORS[0]}`} aria-hidden="true" />
          <span className={`text-2xl font-bold sm:text-3xl ${NUMBER_COLORS[0]}`}>{visible[0].percentage}%</span>
        </span>
        {bar}
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={`text-2xl font-bold sm:text-3xl ${NUMBER_COLORS[1]}`}>{visible[1].percentage}%</span>
          <span className={`size-2.5 shrink-0 rounded-full ${SEGMENT_COLORS[1]}`} aria-hidden="true" />
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {bar}
      <p className="text-sm font-medium text-text-secondary">
        Community split: {visible.map((o) => `${o.label} ${o.percentage}%`).join("  |  ")}
      </p>
    </div>
  );
}
