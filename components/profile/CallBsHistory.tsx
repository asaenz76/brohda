import Link from "next/link";
import { LocalDateTime } from "@/components/LocalDateTime";
import { HeadToHeadLine } from "@/components/profile/CallBsRecordLine";
import { cn } from "@/lib/utils";
import type { CallBsHistoryEntry, CallBsOutcome, HeadToHeadRecord } from "@/lib/challenges/history";

// A Profile's recent Call BS results as compact social rows (opponent, Game,
// what was picked, the result in words, the date) with thin separators — not
// a table, not a ledger, not a leaderboard. Each Game links to its Post, the
// canonical place the conversation lives.

const OUTCOME_WORD: Record<CallBsOutcome, string> = { WON: "Won", LOST: "Lost", VOID: "Void" };

export function CallBsHistory({
  entries,
  subjectIsViewer,
  subjectName,
  headToHead,
}: {
  entries: CallBsHistoryEntry[];
  /** Your own Profile reads "You picked …"; someone else's reads "Picked …". */
  subjectIsViewer: boolean;
  subjectName: string;
  /** On someone else's Profile: the viewer's own record against them, when there is one. */
  headToHead?: HeadToHeadRecord | null;
}) {
  return (
    <section aria-label="Call BS" className="space-y-2">
      <h2 className="text-sm font-semibold text-text-primary">Call BS</h2>

      {!subjectIsViewer && headToHead && <HeadToHeadLine opponentName={subjectName} wins={headToHead.wins} losses={headToHead.losses} />}

      {entries.length === 0 ? (
        <p className="text-sm text-text-muted">No Call BS results yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {entries.map((e) => (
            <li key={e.challengeId} className="space-y-0.5 px-4 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-sm text-text-primary [overflow-wrap:anywhere]">
                  <span className="text-text-muted">vs </span>
                  {e.opponent.username ? (
                    <Link href={`/profile/${e.opponent.username}`} aria-label={`Open ${e.opponent.label}'s profile`} className="font-medium underline-offset-4 hover:underline">
                      {e.opponent.label}
                    </Link>
                  ) : (
                    <span className={cn("font-medium", !e.opponent.known && "italic text-text-muted")}>{e.opponent.label}</span>
                  )}
                </p>
                <p className={cn("shrink-0 text-xs font-semibold uppercase tracking-wide", e.outcome === "WON" ? "text-credit" : e.outcome === "LOST" ? "text-debit" : "text-text-muted")}>
                  <span className="sr-only">Result: </span>
                  {OUTCOME_WORD[e.outcome]}
                </p>
              </div>
              <p className="text-sm text-text-secondary [overflow-wrap:anywhere]">
                {e.postId ? (
                  <Link href={`/post/${e.postId}`} aria-label={`Open the Game: ${e.game.label}`} className="underline-offset-4 hover:underline">
                    {e.game.label}
                  </Link>
                ) : (
                  <span className={cn(!e.game.known && "italic text-text-muted")}>{e.game.label}</span>
                )}
              </p>
              <p className="text-xs text-text-muted [overflow-wrap:anywhere]">
                {(e.marketLabel ?? e.question) && <>{e.marketLabel ?? e.question} · </>}
                {e.pickLabel && (
                  <>
                    {subjectIsViewer ? "You picked" : "Picked"} {e.pickLabel} ·{" "}
                  </>
                )}
                {e.opponentPickLabel && (
                  <>
                    {e.opponent.known ? e.opponent.label : "They"} picked {e.opponentPickLabel} ·{" "}
                  </>
                )}
                {e.resolvedAt ? <LocalDateTime iso={e.resolvedAt} options={{ month: "short", day: "numeric" }} /> : "—"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
