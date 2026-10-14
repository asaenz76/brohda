import { Card, CardContent } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import type { MetricKey, SponsorRate, SponsorRates, SponsorReport } from "@/lib/sponsor-intelligence/report";
import type { SuppressedBreakdown } from "@/lib/sponsor-intelligence/suppression";

// What a Sponsor sees about ONE of their own campaigns, once Super Admin has switched Sponsor Intelligence on. Aggregate only: every figure has already been through the small-cohort
// suppression, and nothing on this card can name, list or link to an individual Member. A withheld figure says so plainly instead of showing a misleading zero.

export interface MetricRow {
  /** A counted figure (`metric`) or a percentage derived from two shown figures (`rate`). */
  kind: "metric" | "rate";
  key: string;
  label: string;
  help: string;
}

const GROUPS: Array<{ title: string; rows: MetricRow[] }> = [
  {
    title: "Reach",
    rows: [
      { kind: "metric", key: "uniqueViewers", label: "Members who saw it", help: "Different Members for whom the Presented-by line was at least half visible for a second." },
      { kind: "metric", key: "repeatViewers", label: "Repeat viewers", help: "Members who saw it on more than one day." },
      { kind: "metric", key: "impressions", label: "Impressions", help: "Times Members saw it — counted once per Member per day." },
      { kind: "metric", key: "clicks", label: "Link clicks", help: "People who followed the link, Members or visitors." },
    ],
  },
  {
    title: "Predictions",
    rows: [
      { kind: "metric", key: "pickMembers", label: "Members who made a Pick", help: "On any Market of this Game while the campaign was running." },
      { kind: "metric", key: "picks", label: "Picks made", help: "One per Member per Market." },
      { kind: "rate", key: "participation", label: "Viewers who made a Pick", help: "Of the Members who saw it, the share who made a Pick on this Game." },
    ],
  },
  {
    title: "Conversation",
    rows: [
      { kind: "metric", key: "commenters", label: "Members who commented", help: "Comments or replies on this Game's Post while the campaign was running." },
      { kind: "metric", key: "comments", label: "Comments", help: "Top-level comments on this Game's Post." },
      { kind: "metric", key: "replies", label: "Replies", help: "Replies to comments on this Game's Post." },
    ],
  },
  {
    title: "Call BS",
    rows: [
      { kind: "metric", key: "callBsMembers", label: "Members who used Call BS", help: "Members on either side of a Call BS on this Game." },
      { kind: "metric", key: "callBsChallenges", label: "Call BS challenges", help: "Free Call BS challenges made on this Game's Markets." },
      { kind: "metric", key: "callBsAccepted", label: "Accepted Call BS challenges", help: "Call BS challenges the other Member accepted." },
      { kind: "rate", key: "callBsAcceptance", label: "Call BS acceptance rate", help: "Of the Call BS challenges the other Member answered (accepted or declined), the share they accepted. Challenges still waiting or left unanswered are not counted." },
      { kind: "rate", key: "callBsEngagement", label: "Pickers who used Call BS", help: "Of the Members who made a Pick on this Game, the share who used Call BS." },
    ],
  },
  {
    title: "Loyalty",
    rows: [{ kind: "metric", key: "returningMembers", label: "Returning Members", help: "Members who made a Pick on this Game and on another of your sponsored Games." }],
  },
];

export function MetricValue({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  return value === null ? (
    <span className="text-text-muted" data-slot="metric-withheld">Not enough data yet</span>
  ) : (
    <span className="font-medium tabular-nums text-text-primary">
      {value.toLocaleString("en-US")}
      {suffix}
    </span>
  );
}

function RateValue({ value }: { value: SponsorRate }) {
  return value === "none" ? <span className="text-text-muted" data-slot="rate-none">—</span> : <MetricValue value={value} suffix="%" />;
}

function Breakdown({ title, note, data, otherLabel, slot }: { title: string; note: string; data: SuppressedBreakdown; otherLabel: string; slot: string }) {
  const empty = data.cells.length === 0 && data.other === null;
  return (
    <div className="space-y-1" data-slot={slot}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
      {empty ? (
        <p className="text-sm text-text-muted">Not enough data yet</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {data.cells.map((c) => (
            <li key={c.key} className="flex items-baseline justify-between gap-3">
              <span className="text-text-secondary">{c.label}</span>
              <span className="font-medium tabular-nums text-text-primary">{c.count.toLocaleString("en-US")}</span>
            </li>
          ))}
          {data.other !== null && (
            <li className="flex items-baseline justify-between gap-3">
              <span className="text-text-secondary">{otherLabel}</span>
              <span className="font-medium tabular-nums text-text-primary">{data.other.toLocaleString("en-US")}</span>
            </li>
          )}
        </ul>
      )}
      <p className="text-xs text-text-muted">{note}</p>
    </div>
  );
}

export function SponsorResultsCard({ report }: { report: SponsorReport }) {
  return (
    <Card data-slot="sponsor-results">
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-text-primary">Results</h2>
          <p className="text-xs text-text-muted">
            Counted from <LocalDateTime iso={report.windowStart ?? new Date().toISOString()} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
            {report.windowEnd ? (
              <>
                {" "}
                to <LocalDateTime iso={report.windowEnd} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
              </>
            ) : null}
            . Only Brohda Members are counted.
          </p>
        </div>

        {GROUPS.map((group) => (
          <div key={group.title} className="space-y-1" data-slot={`results-${group.title.toLowerCase()}`}>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">{group.title}</h3>
            <dl className="space-y-1 text-sm">
              {group.rows.map((row) => (
                <div key={row.key} className="flex items-baseline justify-between gap-3" data-slot={`${row.kind === "rate" ? "rate" : "metric"}-${row.key}`}>
                  <dt className="text-text-secondary" title={row.help}>
                    {row.label}
                  </dt>
                  <dd>
                    {row.kind === "rate" ? <RateValue value={report.rates[row.key as keyof SponsorRates]} /> : <MetricValue value={report.metrics[row.key as MetricKey]} />}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}

        {report.markets.length > 0 && (
          <div className="space-y-1" data-slot="results-markets">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Picks by Market</h3>
            <ul className="space-y-1.5 text-sm">
              {report.markets.map((m) => (
                <li key={m.marketId} className="space-y-0.5" data-slot="market-row">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-text-secondary">{m.label}</span>
                    <MetricValue value={m.members} suffix=" Members" />
                  </div>
                  {m.members !== null && (
                    <p className="text-xs text-text-muted" data-slot="market-sentiment">
                      {m.sentiment ? m.sentiment.map((c) => `${c.label} ${c.percent}%`).join(" · ") : "Split not shown yet — too few Members on one side"}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Breakdown
            title="Sports they also pick"
            note={`Members reached who made a Pick in each sport in the last ${report.affinityLookbackDays} days. A Member can appear in more than one sport.`}
            data={report.sportAffinity}
            otherLabel="Other sports"
            slot="affinity-sport"
          />
          <Breakdown
            title="Teams they follow"
            note="Members reached who follow each Team community. A Member can follow more than one."
            data={report.teamAffinity}
            otherLabel="Other teams"
            slot="affinity-team"
          />
        </div>

        <p className="text-xs text-text-muted" data-slot="privacy-note">
          To protect Members&apos; privacy, figures based on fewer than {report.minCohort} Members are not shown. Brohda never shares who the Members are.
          {report.anySuppressed ? " Some figures are being withheld for this campaign." : ""}
        </p>
      </CardContent>
    </Card>
  );
}
