import Link from "next/link";
import { ChevronRight, Flame } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Member's Confidence in the signed-in shell: ONE labelled summary — the title, the total, what is available and what is reserved behind their picks — that is one link to the Confidence page. It reads the Confidence domain only
 * (never the wallet, no currency) and has two layouts of the same content, one per breakpoint (the other is `display: none`, so a viewer only ever meets one):
 *   - `rail`: the block in the navigation rail's lower section, where the Wallet balance used to sit.
 *   - `banner`: the phone's equivalent, full width at the top of every page (the top bar's bare "🔥50" chip said too little). The three figures are readable without opening the Menu or the profile.
 * Both carry the same accessible label so every surface says the same thing: "Confidence: 50 total, 32 available, 18 reserved behind your picks".
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

/** "🔥32 available": the flame, the number and its first word never separate; any further words ("behind your picks") may wrap, so a narrow rail shows the whole phrase instead of cutting it off. */
function Figure({ value, label, unbreakable = false }: { value: number; label: string; unbreakable?: boolean }) {
  const [first, ...rest] = label.split(" ");
  return (
    <span className={unbreakable ? "whitespace-nowrap" : undefined}>
      <span className="whitespace-nowrap">
        <FlameMark className="mr-0.5 size-3 align-[-1px]" />
        <span className="font-semibold text-text-primary">{n(value)}</span> {first}
      </span>
      {rest.length > 0 && ` ${rest.join(" ")}`}
    </span>
  );
}

export function ConfidenceSummary({
  total,
  available,
  reserved,
  variant = "rail",
  active = false,
  className,
}: ConfidenceFigures & {
  variant?: "rail" | "banner";
  active?: boolean;
  className?: string;
}) {
  const label = `${confidenceSummaryLabel({ total, available, reserved })}. Open Confidence history`;

  if (variant === "banner") {
    return (
      <Link
        href="/profile/confidence"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-slot="shell-confidence"
        data-variant="banner"
        className={cn(
          "flex min-h-14 items-center gap-3 rounded-lg border border-border-subtle bg-surface-secondary px-3.5 py-2.5 outline-none transition-colors hover:bg-surface-secondary/70 focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        <FlameMark className="size-5 text-text-secondary" />
        <span className="min-w-0 flex-1 space-y-0.5" aria-hidden="true">
          <span className="flex items-baseline justify-between gap-3">
            <span className="text-[15px] font-semibold text-text-primary">Confidence</span>
            <span className="text-[15px] text-text-secondary">
              <Figure value={total} label="total" />
            </span>
          </span>
          {/* Each figure is one unbreakable item: when the phone is too narrow for both on a line, "reserved behind your picks" moves down whole instead of breaking mid-phrase. */}
          <span className="flex flex-wrap gap-x-2 text-[13px] leading-snug text-text-secondary">
            <Figure value={available} label="available" unbreakable />
            <span aria-hidden="true" className="hidden min-[480px]:inline">
              ·
            </span>
            <Figure value={reserved} label="reserved behind your picks" unbreakable />
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
      </Link>
    );
  }

  return (
    <Link
      href="/profile/confidence"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-slot="shell-confidence"
      data-variant="rail"
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
          <Figure value={total} label="total" />
        </span>
        <span className="block space-y-0.5 text-xs leading-snug text-text-secondary">
          <span className="block">
            <Figure value={available} label="available" />
          </span>
          <span className="block">
            <Figure value={reserved} label="reserved behind your picks" />
          </span>
        </span>
      </span>
    </Link>
  );
}
