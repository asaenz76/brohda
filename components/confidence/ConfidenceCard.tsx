import Link from "next/link";
import { getMyConfidence } from "@/lib/confidence/service";
import { ClaimPanel } from "./ClaimPanel";
import { formatConfidence } from "@/lib/confidence/format";

/** "Your Confidence" on your own profile. Renders NOTHING while the capability is OFF (no placeholder, no unfinished UI), and nothing for an account that isn't eligible. */
export async function ConfidenceCard({ memberId }: { memberId: string }) {
  const mine = await getMyConfidence(memberId).catch(() => null);
  if (!mine) return null;
  return (
    <section aria-label="Confidence" data-slot="confidence-card" className="space-y-2 rounded-lg border border-border-subtle p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Confidence</h2>
        <Link href="/profile/confidence" className="text-xs font-medium text-text-secondary hover:text-text-primary">
          History
        </Link>
      </div>
      {mine.reserved > 0 && (
        <p className="text-xs text-text-secondary" data-slot="confidence-card-split">
          {formatConfidence(mine.available)} available · {formatConfidence(mine.reserved)} reserved behind your picks
        </p>
      )}
      <ClaimPanel initialTotal={mine.total} canClaim={mine.canClaim} claimAmount={mine.claimAmount} nextClaimAt={mine.nextClaimAt} atOrAboveBaseline={mine.atOrAboveBaseline} />
    </section>
  );
}
