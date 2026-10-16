import Link from "next/link";
import { confidenceLabel, formatConfidence } from "@/lib/confidence/format";

/**
 * The Member's Confidence at a glance, in the signed-in shell: a compact "🔥50" that links to their Confidence history. It shows TOTAL Confidence (their reputation number); when some is reserved behind a Pick it is
 * still one number, with the available/reserved split in the tooltip and the screen-reader label and on the history page — never several numbers at once. The flame is decoration: the accessible text is "50 Confidence".
 * It reads the Confidence domain only (no wallet, no currency) and is rendered only for a Member while Confidence is on.
 */
export function ConfidenceBalance({ total, available, reserved, className }: { total: number; available: number; reserved: number; className?: string }) {
  const split = reserved > 0 ? `${available} available, ${reserved} reserved` : null;
  const label = split ? `${confidenceLabel(total)}: ${split}` : confidenceLabel(total);
  return (
    <Link
      href="/profile/confidence"
      aria-label={`${label}. Open your Confidence history`}
      title={split ? `Available ${available} · Reserved ${reserved}` : "Your Confidence"}
      data-slot="shell-confidence"
      className={className}
    >
      <span aria-hidden="true">{formatConfidence(total)}</span>
    </Link>
  );
}
