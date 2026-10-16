import Link from "next/link";
import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Member's Confidence in the signed-in shell. Two shapes of the same data, both reading the Confidence domain only (never the wallet, no currency):
 *   - `ConfidenceSummary`: the labelled block in the navigation where the Wallet row sits — title, total, available and reserved — one link to the Confidence page.
 *   - `ConfidenceBalance`: the compact chip in the phone's top bar (the total, with the flame), so the number is in view without opening the menu.
 * They share one accessible label so every surface says the same thing: "Confidence: 50 total, 32 available, 18 reserved behind your picks".
 */
export interface ConfidenceFigures {
  total: number;
  available: number;
  reserved: number;
}

const n = (value: number) => value.toLocaleString("en-US");

export function confidenceSummaryLabel({ total, available, reserved }: ConfidenceFigures): string {
  return `Confidence: ${n(total)} total, ${n(available)} available, ${n(reserved)} reserved behind your picks`;
}

/** The product's flame, drawn as an icon (like every other shell glyph) rather than a native emoji, in the same neutral ink as the text: orange stays reserved for streaks. */
function FlameMark({ className }: { className?: string }) {
  return <Flame aria-hidden="true" className={cn("inline-block shrink-0 fill-current", className)} />;
}

function Figure({ value, children }: { value: number; children: React.ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <FlameMark className="mr-0.5 size-3 align-[-1px]" />
      <span className="font-semibold text-text-primary">{n(value)}</span> {children}
    </span>
  );
}

export function ConfidenceSummary({
  total,
  available,
  reserved,
  active = false,
  stacked = false,
  onNavigate,
  className,
}: ConfidenceFigures & {
  active?: boolean;
  /** Narrow rail: available and reserved on their own lines. Wide (the phone menu): "available · reserved behind your picks" on one line. */
  stacked?: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      href="/profile/confidence"
      onClick={onNavigate}
      aria-label={`${confidenceSummaryLabel({ total, available, reserved })}. Open your Confidence history`}
      aria-current={active ? "page" : undefined}
      data-slot="shell-confidence"
      className={cn(
        "flex gap-3 rounded-md px-3 py-2 text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        active ? "bg-surface-secondary" : "hover:bg-surface-secondary",
        className,
      )}
    >
      <FlameMark className="mt-0.5 size-5 text-text-secondary" />
      <span className="min-w-0 space-y-0.5" aria-hidden="true">
        <span className="block font-medium text-text-primary">Confidence</span>
        <span className="block text-sm text-text-secondary">
          <Figure value={total}>total</Figure>
        </span>
        {stacked ? (
          <span className="block space-y-0.5 text-xs leading-snug text-text-muted">
            <span className="block">
              <Figure value={available}>available</Figure>
            </span>
            <span className="block">
              <Figure value={reserved}>reserved behind your picks</Figure>
            </span>
          </span>
        ) : (
          <span className="block text-xs leading-snug text-text-muted">
            <Figure value={available}>available</Figure>
            {" · "}
            <Figure value={reserved}>reserved behind your picks</Figure>
          </span>
        )}
      </span>
    </Link>
  );
}

/** The compact phone top-bar chip: the flame and the total, with the full breakdown in the accessible label. */
export function ConfidenceBalance({ total, available, reserved, className }: ConfidenceFigures & { className?: string }) {
  return (
    <Link href="/profile/confidence" aria-label={`${confidenceSummaryLabel({ total, available, reserved })}. Open your Confidence history`} data-slot="shell-confidence" className={className}>
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        <FlameMark className="size-4" />
        {n(total)}
      </span>
    </Link>
  );
}
