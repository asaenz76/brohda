"use client";

import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/utils/money";

interface PoolOptionButtonProps {
  label: string;
  logoUrl: string | null;
  percentage: number | null;
  /** Pari-mutuel "if this option wins" live estimate — rendered right next
   *  to `percentage`, gated the same way (null until distribution is
   *  visible to this viewer). */
  estimatedPayout: number | null;
  isCurrentUserChoice: boolean;
  disabled: boolean;
  onSelect: () => void;
}

// X.5.6-X.5.10: large touch-friendly control; indigo glow + "Your Choice"
// badge once selected; percentage revealed only when the view-model already
// allowed it (privacy is enforced upstream at the query layer, not here).
export function PoolOptionButton({
  label,
  logoUrl,
  percentage,
  estimatedPayout,
  isCurrentUserChoice,
  disabled,
  onSelect,
}: PoolOptionButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={isCurrentUserChoice}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors",
        isCurrentUserChoice
          ? "border-accent-primary bg-accent-primary/10"
          : "border-border-subtle bg-surface-primary hover:border-accent-primary/50",
        disabled && !isCurrentUserChoice && "cursor-not-allowed opacity-60",
      )}
    >
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-8 rounded-full object-contain" />
      ) : null}
      <span className="flex-1 text-sm font-semibold text-text-primary">{label}</span>
      <div className="flex items-center gap-2">
        {isCurrentUserChoice && (
          <span className="rounded-full bg-accent-primary px-2 py-0.5 text-xs font-medium text-white">
            Your Choice
          </span>
        )}
        {percentage != null && (
          <div className="flex flex-col items-end leading-tight">
            <span className="text-sm font-medium text-text-secondary">Picked by {percentage}%</span>
            {estimatedPayout != null && (
              <span className="text-xs font-semibold text-accent-primary">
                Est. payout {formatCents(estimatedPayout)}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
