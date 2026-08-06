import Link from "next/link";
import { Wallet } from "lucide-react";
import { formatCents } from "@/lib/utils/money";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function BalancePill({ balanceCents }: { balanceCents: number }) {
  return (
    <Link
      href="/wallet"
      className={cn(
        badgeVariants({ variant: "primary", size: "lg" }),
        "transition-colors hover:bg-surface-elevated",
      )}
    >
      <Wallet className="size-3.5 text-text-muted" aria-hidden="true" />
      {formatCents(balanceCents)}
    </Link>
  );
}
