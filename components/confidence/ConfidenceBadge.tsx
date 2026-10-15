import { confidenceLabel, formatConfidence } from "@/lib/confidence/format";

/** A Member's Confidence as a public reputation signal: "🔥50", with the words for screen readers. The flame is decoration; the label carries the meaning. */
export function ConfidenceBadge({ points, className }: { points: number; className?: string }) {
  return (
    <span className={className} data-slot="confidence-badge" aria-label={confidenceLabel(points)}>
      <span aria-hidden="true">{formatConfidence(points)}</span>
    </span>
  );
}
