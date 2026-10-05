import { cn } from "@/lib/utils";

/**
 * The compact Call BS record — "Call BS: 8–4" — as secondary identity
 * context under the prediction reputation. Wins–losses only: no percentage,
 * no rank, no points. Renders nothing for someone with no resolved wins or
 * losses (a "0–0" would only be noise); a screen reader hears the words, the
 * eye sees the compact form.
 */
export function CallBsRecordLine({ wins, losses, className }: { wins: number; losses: number; className?: string }) {
  if (wins + losses === 0) return null;
  const spoken = `Call BS record: ${wins} ${wins === 1 ? "win" : "wins"}, ${losses} ${losses === 1 ? "loss" : "losses"}`;
  return (
    <p className={cn("text-xs text-text-muted", className)}>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true">
        Call BS: {wins}–{losses}
      </span>
    </p>
  );
}

/** The pair-specific version: "Your Call BS record vs Carlos: 2–1", shown only when the two of you have resolved history. */
export function HeadToHeadLine({ opponentName, wins, losses, className }: { opponentName: string; wins: number; losses: number; className?: string }) {
  if (wins + losses === 0) return null;
  const spoken = `Your Call BS record against ${opponentName}: ${wins} ${wins === 1 ? "win" : "wins"}, ${losses} ${losses === 1 ? "loss" : "losses"}`;
  return (
    <p className={cn("text-xs text-text-muted", className)}>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true">
        Your Call BS record vs {opponentName}: {wins}–{losses}
      </span>
    </p>
  );
}
