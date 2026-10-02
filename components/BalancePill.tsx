import Link from "next/link";
import { Wallet } from "lucide-react";
import { formatCents } from "@/lib/utils/money";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The header balance: what's available to act on right now. Money on hold
 * (an open proposal, an accepted Position, a pending withdrawal) is still
 * the person's, but can't be put on anything else, so it's left out of the
 * headline number and noted beside it instead — the wallet page has the
 * full total/available/on-hold breakdown.
 *
 * The hold note is hidden below `sm` so the header never crowds on a phone;
 * the title and accessible name carry it at every width.
 */
export function BalancePill({ availableCents, heldCents }: { availableCents: number; heldCents: number }) {
  const available = formatCents(availableCents);
  const held = heldCents > 0 ? formatCents(heldCents) : null;
  const description = held ? `${available} available, ${held} on hold` : `${available} available`;

  return (
    <Link
      href="/wallet"
      title={description}
      aria-label={`Wallet: ${description}`}
      className={cn(
        badgeVariants({ variant: "primary", size: "lg" }),
        "transition-colors hover:bg-surface-elevated",
      )}
    >
      <Wallet className="size-3.5 text-text-muted" aria-hidden="true" />
      {available}
      {held && (
        <span className="hidden text-xs font-normal text-text-muted sm:inline" aria-hidden="true">
          · {held} on hold
        </span>
      )}
    </Link>
  );
}
