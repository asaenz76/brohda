import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { PoolStatus } from "@/components/pools/PoolStatus";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";

// The compact "list/compact view" density level from the approved mockup —
// a single-line row (small crest, matchup or question, status, chevron)
// for browsing many pools at once, distinct from SocialPoolCard's own
// `collapsible` mode (which still renders a full interactive card, just
// starting collapsed). Tapping this row navigates to the pool's detail
// page rather than expanding inline — this is a browsing surface, not an
// entry surface. Not yet wired into a real route (Feed/Profile still use
// the full card); built now so the density level exists and can be
// reviewed, wiring is a separate integration decision.
export function PoolListRow({ viewModel }: { viewModel: SocialPoolCardViewModel }) {
  const { fixture } = viewModel;
  const matchup =
    fixture.homeTeamName && fixture.awayTeamName
      ? `${fixture.homeTeamName} vs ${fixture.awayTeamName}`
      : viewModel.question;

  return (
    <Link
      href={`/pool/${viewModel.poolId}`}
      className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface-primary px-3 py-2.5 hover:bg-surface-secondary"
    >
      {fixture.homeTeamLogoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fixture.homeTeamLogoUrl} alt="" className="size-8 shrink-0 rounded-full object-contain" />
      ) : (
        <span className="size-8 shrink-0 rounded-full bg-surface-elevated" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text-primary">{matchup}</p>
        <p className="truncate text-xs text-text-muted">{viewModel.question}</p>
      </div>
      <PoolStatus status={viewModel.status} />
      <ChevronRight className="size-4 shrink-0 text-text-muted" aria-hidden="true" />
    </Link>
  );
}
