import { confidenceLabel, formatConfidence } from "@/lib/confidence/format";

/** The committed amount on the viewer's own prediction — the same line on every surface (the Post detail's card and the feed card). */
export function CommittedConfidence({ amount, pending }: { amount: number; pending: boolean }) {
  return (
    <p className="text-sm font-medium text-text-primary" data-slot="pick-confidence" aria-label={`${confidenceLabel(amount)}${pending ? ", locked" : ""}`}>
      <span aria-hidden="true">
        {formatConfidence(amount)} Confidence{pending ? " · Locked" : ""}
      </span>
    </p>
  );
}
