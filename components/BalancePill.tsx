import Link from "next/link";
import { Wallet } from "lucide-react";
import { formatCents } from "@/lib/utils/money";

export function BalancePill({ balanceCents }: { balanceCents: number }) {
  return (
    <Link
      href="/wallet"
      className="inline-flex items-center gap-1.5 rounded-full bg-surface-secondary px-3 py-1 text-sm font-medium text-text-primary transition-colors hover:bg-surface-elevated"
    >
      <Wallet className="size-3.5 text-text-muted" aria-hidden="true" />
      {formatCents(balanceCents)}
    </Link>
  );
}
