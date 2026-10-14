import type { AdminCampaignResults } from "@/lib/sponsor-intelligence/service";
import { METRIC_KEYS, type MetricKey } from "@/lib/sponsor-intelligence/report";

// Super Admin: the EXACT numbers for one campaign, beside what the Sponsor would currently be shown. Operational — it does not depend on the Sponsor Intelligence capability being ON,
// and it still contains only counts and labels (no Member is identified here either).

const LABEL: Record<MetricKey, string> = {
  uniqueViewers: "Members who saw it",
  repeatViewers: "Repeat viewers",
  impressions: "Impressions",
  clicks: "Link clicks",
  pickMembers: "Members who made a Pick",
  viewersWhoPicked: "Viewers who made a Pick",
  picks: "Picks made",
  commenters: "Members who commented",
  comments: "Comments",
  replies: "Replies",
  callBsMembers: "Members who used Call BS",
  callBsPickers: "Pickers who used Call BS",
  callBsChallenges: "Call BS challenges",
  callBsAccepted: "Accepted Call BS challenges",
  callBsAnswered: "Answered Call BS challenges (accepted or declined)",
  returningMembers: "Returning Members",
};

export function AdminResultsCard({ results }: { results: Extract<AdminCampaignResults, { state: "ready" }> }) {
  const { report, policy, capabilityEnabled } = results;
  const { exact, sponsorView } = report;
  return (
    <section aria-label="Campaign performance" data-slot="admin-results" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Performance (exact)</h2>
      <p className="text-xs text-text-muted" data-slot="admin-results-visibility">
        Sponsor Intelligence is <span className="font-medium text-text-primary">{capabilityEnabled ? "ON" : "OFF"}</span>
        {capabilityEnabled ? `: the Sponsor sees the right-hand column, with figures under ${policy.minCohort} Members withheld.` : ": the Sponsor sees none of this."} Only Members are counted — never staff.
      </p>
      {!exact.started ? (
        <p className="text-text-secondary">The campaign has not started presenting yet, so there is nothing to count.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-text-muted">
              <th className="py-1 font-medium">Figure</th>
              <th className="py-1 text-right font-medium">Exact</th>
              <th className="py-1 text-right font-medium">Sponsor sees</th>
            </tr>
          </thead>
          <tbody>
            {METRIC_KEYS.map((key) => (
              <tr key={key} data-slot={`admin-metric-${key}`} className="border-t border-border-subtle">
                <td className="py-1 text-text-secondary">{LABEL[key]}</td>
                <td className="py-1 text-right font-medium tabular-nums text-text-primary" data-slot="exact">{exact[key].toLocaleString("en-US")}</td>
                <td className="py-1 text-right tabular-nums text-text-secondary" data-slot="sponsor-sees">
                  {sponsorView.metrics[key] === null ? "withheld" : sponsorView.metrics[key]!.toLocaleString("en-US")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* Exact per-side counts and affinity are for Super Admin only. They sit in their own block, apart from the "Sponsor sees" column above, so nothing here can be mistaken for what a Sponsor is shown. */}
      <div className="space-y-1 rounded-md border border-dashed border-border-subtle p-2" data-slot="admin-only-detail">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Super Admin only — never shown to Sponsors</p>
        {results.report.adminMarkets.length > 0 && (
          <ul className="space-y-0.5 text-xs text-text-secondary" data-slot="admin-markets">
            {results.report.adminMarkets.map((m) => (
              <li key={m.marketId}>
                {m.label}: {m.members} Members — {m.yesLabel} {m.yesCount} · {m.noLabel} {m.noCount}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted">
          Affinity (last {exact.affinityLookbackDays} days): {report.adminSportAffinity.length === 0 ? "no sport data yet" : report.adminSportAffinity.map((c) => `${c.label} ${c.count}`).join(", ")}
          {exact.teamAffinity.length > 0 ? ` · Teams followed: ${exact.teamAffinity.slice(0, 8).map((c) => `${c.label} ${c.count}`).join(", ")}` : ""}.
        </p>
      </div>
    </section>
  );
}
