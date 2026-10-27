import { ChallengeAction } from "@/components/predictions/ChallengeAction";
import type { GameCallBsStatus } from "@/lib/challenges/game-status";
import type { ChallengeTone } from "@/lib/challenges/presentation";

// Brohda 2.1 M4 — "Your Call BS" at the top of the Post: the one place a Member sees every Call BS they are in on this Game (waiting for them, locked, decided, ended), in words — never colour alone — and, for an
// incoming one, where they answer it. It renders nothing when the Member has no Call BS on the Game. Free, nonmonetary: nothing here mentions a price, a stake or a prize.

const TONE_TAG: Record<ChallengeTone, string> = {
  action: "Needs your answer",
  waiting: "Waiting",
  locked: "Locked in",
  won: "You won",
  lost: "You lost",
  void: "Void",
  ended: "Ended",
};

const TONE_CLASS: Record<ChallengeTone, string> = {
  action: "border-accent-primary/60 bg-accent-primary/5",
  waiting: "border-border-subtle",
  locked: "border-border-strong bg-secondary",
  won: "border-border-strong bg-secondary",
  lost: "border-border-subtle",
  void: "border-border-subtle",
  ended: "border-border-subtle",
};

export function CallBsStatusCard({ status }: { status: GameCallBsStatus }) {
  if (status.items.length === 0) return null;
  return (
    <section id="call-bs" aria-labelledby="call-bs-heading" data-slot="call-bs-status" className="scroll-mt-16 space-y-2">
      <h2 id="call-bs-heading" className="text-xs font-medium uppercase tracking-wide text-text-muted">
        Your Call BS
      </h2>
      <div className="space-y-2">
        {status.items.map(({ challenge, view }) => (
          <div
            key={challenge.id}
            data-slot="call-bs-item"
            data-tone={view.tone}
            data-outcome={view.outcome ?? undefined}
            data-challenge-id={challenge.id}
            className={`space-y-1 rounded-lg border p-3 ${TONE_CLASS[view.tone]}`}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{TONE_TAG[view.tone]}</p>
            <p className="text-sm font-semibold text-text-primary">{view.headline}</p>
            <p className="text-sm text-text-secondary">{view.detail}</p>
            {view.canRespond && (
              <div className="pt-1">
                <ChallengeAction marketId={challenge.marketId} state={{ kind: "incoming_pending", challengeId: challenge.id }} />
              </div>
            )}
          </div>
        ))}
      </div>
      {status.more > 0 && <p className="text-xs text-text-muted">and {status.more} more</p>}
    </section>
  );
}
