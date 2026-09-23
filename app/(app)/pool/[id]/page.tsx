import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getPoolCardViewModels } from "@/lib/pools/fetch";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { getWalletBalanceSummary } from "@/lib/wallet/reservations";
import { SocialPoolCard } from "@/components/pools/SocialPoolCard";

// Direct-link access path for HIDDEN pools (Decision 7): RLS already allows
// any authenticated member to read a non-draft pool regardless of
// visibility — "never appears in the feed" is purely the Feed query's
// WHERE clause, not an RLS distinction.
export default async function PoolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  const [viewModels, summary, paymentMethods] = await Promise.all([
    getPoolCardViewModels([id], user.id),
    getWalletBalanceSummary(user.id),
    getPaymentMethods(),
  ]);

  const viewModel = viewModels[0];
  if (!viewModel) notFound();

  return (
    <>
      <h1 className="sr-only">{viewModel.question}</h1>
      <SocialPoolCard
        viewModel={viewModel}
        balanceCents={summary.available}
        paymentMethods={paymentMethods.filter((m) => m.enabled)}
        viewer={{ id: user.id, isModerator: isAdminOrAbove(user) }}
        isDetailPage
      />
    </>
  );
}
