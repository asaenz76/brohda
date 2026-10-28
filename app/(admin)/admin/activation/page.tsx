import { requireSuperAdmin } from "@/lib/auth/session";
import { getActivationFunnel } from "@/lib/activation/repository";
import { MIN_COHORT, rateLabel, tooSmall } from "@/lib/activation/format";
import type { ActivationFunnel } from "@/lib/activation/types";

// Brohda 2.1 M7 — the activation and return funnel for the Super Admin: aggregates only, derived from the rows Brohda already keeps (migration 220). No Member is named, nothing is tracked, and signed-out visits are not
// measured (they are not in the database). With a handful of Members the percentages are withheld on purpose: these are a foundation to read once real people arrive, not a claim about today.
export const dynamic = "force-dynamic";

const DAYS = 30;

function Row({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <tr className="border-t border-border-subtle align-top" data-slot="activation-row">
      <td className="px-3 py-2">
        <p className="font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted">{note}</p>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-text-primary">{value}</td>
    </tr>
  );
}

export default async function ActivationPage() {
  await requireSuperAdmin();
  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);
  let funnel: ActivationFunnel | null = null;
  try {
    funnel = await getActivationFunnel(from.toISOString(), to.toISOString());
  } catch (error) {
    console.error("[activation] could not load the funnel:", error instanceof Error ? error.message : error);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Activation &amp; return</h1>
        <p className="text-sm text-text-muted">
          Players who registered in the last {DAYS} days, followed from sign-up to their first Pick, their second, and back after a result. Aggregates only: no Member is named and nothing is tracked. Percentages appear only when
          there are at least {MIN_COHORT} Members to measure; below that you see the plain counts.
        </p>
      </div>
      {!funnel ? (
        <p className="rounded-lg border border-border-subtle px-4 py-6 text-sm text-text-muted" data-slot="activation-error">
          The funnel couldn&apos;t be loaded right now.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full text-sm">
            <tbody>
              <Row label="Registered" value={String(funnel.registered)} note="Players who created an account in this window." />
              <Row label="Activated: first Pick within 24 hours" value={rateLabel(funnel.pickedWithin24h, funnel.registered24hOld)} note="Of those registered at least 24 hours ago. The first Pick is the activation event." />
              <Row label="Made a Pick at any time" value={rateLabel(funnel.pickedEver, funnel.registered)} note="Of everyone registered in the window." />
              <Row label="Median time to first Pick" value={funnel.medianMinutesToFirstPick === null ? "—" : `${funnel.medianMinutesToFirstPick} min`} note="From sign-up, among those who picked." />
              <Row label="Early retention: second Pick within 7 days" value={rateLabel(funnel.secondPickWithin7d, funnel.activated7dOld)} note="Of Members whose first Pick is at least 7 days old." />
              <Row label="Result loop: back within 48 hours of the first result" value={rateLabel(funnel.cameBackWithin48h, funnel.firstGraded48hOld)} note="Made another Pick, or opened their result notification, within 48 hours of their first graded Pick (of those whose first result is at least 48 hours old)." />
              <Row label="Commented" value={String(funnel.commented)} note="Registered in the window and have written at least one comment." />
              <Row label="Started a Call BS" value={String(funnel.calledBs)} note="Registered in the window and have called BS on someone." />
              <Row label="Ranked on this week's leaderboard" value={String(funnel.rankedThisWeek)} note={`Players with at least ${funnel.weeklyMinDecided} decided Picks this week (all players, not only this window).`} />
            </tbody>
          </table>
        </div>
      )}
      {funnel && tooSmall(funnel.registered24hOld) && (
        <p className="text-xs text-text-muted" data-slot="activation-small">
          Fewer than {MIN_COHORT} Members are old enough to measure, so no percentage is shown. Do not read a trend into these counts.
        </p>
      )}
      {funnel && funnel.byWeek.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-text-primary">By registration week</h2>
          <ul className="text-sm text-text-secondary">
            {funnel.byWeek.map((w) => (
              <li key={w.week} className="tabular-nums">
                Week of {w.week}: {w.registered} registered, {w.pickedWithin24h} picked within 24 hours
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-text-muted">Signed-out visits and &ldquo;sign-up started&rdquo; are not stored anywhere, so they are not shown. Everything above is read from predictions, notifications, comments and Call BS that already exist.</p>
    </div>
  );
}
