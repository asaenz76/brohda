import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { bestStreakLabel, formLabel, formSpoken, percentIfEnough, recordLabel, sportName, streakLabel } from "@/lib/member-record/format";
import type { MemberOpponent, MemberRecordSummary } from "@/lib/member-record/types";

// Brohda 2.1 M5 — the Member's record, in the order a visitor reads a competitor: how often they are right (raw record first, a percentage only once there is enough to mean something), how they do when someone
// calls BS, their recent form and streak, this week, then where they predict. Real outcomes only: no points, no levels, no badges. Every figure is text (never colour alone). Free for everyone.

function Row({ label, value, detail, slot }: { label: string; value: React.ReactNode; detail?: React.ReactNode; slot: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5" data-slot={slot}>
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="text-right">
        <span className="text-base font-semibold tabular-nums text-text-primary">{value}</span>
        {detail && <span className="ml-2 text-xs text-text-muted">{detail}</span>}
      </dd>
    </div>
  );
}

export function RecordCard({
  summary,
  callBs,
  opponents,
  minDecided,
  subjectIsViewer,
}: {
  summary: MemberRecordSummary;
  callBs: { wins: number; losses: number; void: number };
  opponents: MemberOpponent[];
  /** The configured minimum of decided picks before a percentage is shown (leaderboard_min_decided_picks). */
  minDecided: number;
  subjectIsViewer: boolean;
}) {
  const decided = summary.correct + summary.incorrect;
  const callBsDecided = callBs.wins + callBs.losses;

  if (decided === 0 && summary.void === 0 && callBsDecided === 0) {
    return (
      <Card>
        <CardContent className="space-y-1 pt-4" data-slot="record-empty">
          <h2 className="text-sm font-semibold text-text-primary">Record</h2>
          <p className="text-sm text-text-secondary">{subjectIsViewer ? "Your record starts with your first pick." : "No graded picks yet."}</p>
        </CardContent>
      </Card>
    );
  }

  const picksPercent = percentIfEnough(summary, minDecided);
  const callBsPercent = percentIfEnough({ correct: callBs.wins, incorrect: callBs.losses }, minDecided);
  const form = formLabel(summary.form);
  const streak = streakLabel(summary.currentStreak);
  // The best run of correct picks is said when it is more than one pick and not already the run they are in; a current run of misses never hides it.
  const bestRun = bestStreakLabel(summary.currentStreak, summary.bestCorrectStreak) ?? undefined;
  const week = summary.thisWeek;
  const seasonsMatter = summary.bySport.some((s) => summary.bySeason.filter((x) => x.sport === s.sport).length > 1);

  return (
    <Card>
      <CardContent className="space-y-3 pt-4" data-slot="record-card">
        <h2 className="text-sm font-semibold text-text-primary">Record</h2>
        <dl className="space-y-2">
          <Row
            slot="record-picks"
            label="Picks"
            value={recordLabel(summary)}
            detail={[picksPercent !== null ? `${picksPercent}% correct` : `${decided} decided`, summary.void > 0 ? `${summary.void} void` : null].filter(Boolean).join(" · ")}
          />
          {callBsDecided > 0 && (
            <Row
              slot="record-call-bs"
              label="Call BS"
              value={recordLabel({ correct: callBs.wins, incorrect: callBs.losses })}
              detail={[callBsPercent !== null ? `${callBsPercent}% won` : null, callBs.void > 0 ? `${callBs.void} void` : null].filter(Boolean).join(" · ") || undefined}
            />
          )}
          {form && (
            <div className="space-y-1" data-slot="record-form">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <dt className="text-sm text-text-secondary">Recent form</dt>
                <dd className="text-base font-semibold tabular-nums text-text-primary">{form.replace(/^Last \d+: /, "")}<span className="ml-2 text-xs font-normal text-text-muted">{form.replace(/: .*/, "")}</span></dd>
              </div>
              <p className="text-xs tracking-wide text-text-muted" role="img" aria-label={`Most recent first: ${formSpoken(summary.form)}`}>
                <span aria-hidden="true">{summary.form.map((r, i) => (<span key={i} className={r === "W" ? "font-semibold text-text-primary" : ""}>{r}{i < summary.form.length - 1 ? " " : ""}</span>))}</span>
              </p>
            </div>
          )}
          {streak && <Row slot="record-streak" label="Streak" value={streak} detail={bestRun} />}
          {week.correct + week.incorrect > 0 && <Row slot="record-week" label="This week" value={recordLabel(week)} />}
          {summary.confidence.picks > 0 && (
            <Row slot="record-confidence" label="Backed with Confidence" value={`${summary.confidence.picks} ${summary.confidence.picks === 1 ? "pick" : "picks"}`} detail={summary.confidence.correct + summary.confidence.incorrect > 0 ? `${recordLabel(summary.confidence)} decided` : undefined} />
          )}
        </dl>

        {summary.bySport.length > 0 && (
          <div className="space-y-1 border-t border-border-subtle pt-2" data-slot="record-by-sport">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">By sport</h3>
            <ul className="space-y-0.5">
              {summary.bySport.slice(0, 6).map((s) => {
                const pct = percentIfEnough(s, minDecided);
                return (
                  <li key={s.sport} className="flex justify-between gap-3 text-sm">
                    <span className="text-text-secondary">{sportName(s.sport)}</span>
                    <span className="tabular-nums text-text-primary">
                      {recordLabel(s)}
                      <span className="ml-2 text-xs text-text-muted">{pct !== null ? `${pct}% · ` : ""}{s.correct + s.incorrect} decided</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {seasonsMatter && (
          <div className="space-y-1 border-t border-border-subtle pt-2" data-slot="record-by-season">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">By season</h3>
            <ul className="space-y-0.5">
              {summary.bySeason.slice(0, 6).map((s) => (
                <li key={`${s.sport}-${s.season}`} className="flex justify-between gap-3 text-sm">
                  <span className="text-text-secondary">{sportName(s.sport)} {s.season}</span>
                  <span className="tabular-nums text-text-primary">{recordLabel(s)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {opponents.length > 0 && (
          <div className="space-y-1 border-t border-border-subtle pt-2" data-slot="record-opponents">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Most Call BS played</h3>
            <ul className="space-y-0.5">
              {opponents.map((o) => (
                <li key={o.opponentId} className="flex justify-between gap-3 text-sm">
                  <Link href={`/profile/${o.username ?? o.opponentId}`} className="min-w-0 truncate text-text-primary hover:underline">{o.name}</Link>
                  <span className="shrink-0 tabular-nums text-text-secondary">
                    {recordLabel({ correct: o.wins, incorrect: o.losses })}
                    <span className="ml-2 text-xs text-text-muted">{o.matchups} {o.matchups === 1 ? "matchup" : "matchups"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
